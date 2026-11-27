const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HORIZON_DAYS = 8 * 366;
const LOWEST = [0, 0, 1, 1, 0];
const HIGHEST = [59, 23, 31, 12, 7];

function fieldValues(text: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return undefined;
    const range = match[1];
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [left, right] = range.split("-").map(Number);
      start = left;
      end = right;
    } else {
      start = Number(range);
      end = match[2] !== undefined ? max : start;
    }
    if (start < min || end > max || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export type CronSchedule = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

export function parseCron(text: string): CronSchedule | undefined {
  if (typeof text !== "string") return undefined;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const sets = parts.map((part, index) => fieldValues(part, LOWEST[index], HIGHEST[index]));
  if (sets.some((set) => set === undefined)) return undefined;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays.delete(7)) weekdays.add(0);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    minutes: sorted(minutes),
    hours: sorted(hours),
    days,
    months,
    weekdays,
    anyDay: parts[2].startsWith("*"),
    anyWeekday: parts[4].startsWith("*"),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(ms: number, zone: string): Record<string, number> {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function offset(ms: number, zone: string): number {
  const clock = wallClock(ms, zone);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

function instant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number | undefined {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const tries = [...new Set([guess - offset(guess - DAY, zone), guess - offset(guess + DAY, zone)])];
  const matches = (at: number) => {
    const clock = wallClock(at, zone);
    return clock.day === day && clock.hour === hour && clock.minute === minute;
  };
  return tries.sort((a, b) => a - b).find(matches);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** First scheduled instant strictly after `after`, or undefined if none occurs within the horizon. */
export function nextCronAt(expr: string | CronSchedule, after: number, zone: string): number | undefined {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  if (!cron || !isValidTimeZone(zone)) return undefined;
  const start = wallClock(after, zone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let dayIndex = 0; dayIndex < HORIZON_DAYS; dayIndex++) {
    const date = new Date(first + dayIndex * DAY);
    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const onDay = cron.days.has(date.getUTCDate());
    const onWeekday = cron.weekdays.has(date.getUTCDay());
    const dayOk = cron.anyDay || cron.anyWeekday ? onDay && onWeekday : onDay || onWeekday;
    if (!dayOk) continue;
    for (const hour of cron.hours) {
      if (dayIndex === 0 && hour < start.hour) continue;
      for (const minute of cron.minutes) {
        if (dayIndex === 0 && hour === start.hour && minute <= start.minute) continue;
        const at = instant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, zone);
        if (at !== undefined && at > after) return at;
      }
    }
  }
  return undefined;
}

/** Last scheduled instant at or before `now` after a previous due time. */
export function latestCronAt(
  expr: string | CronSchedule,
  after: number,
  now: number,
  zone: string,
): number | undefined {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  if (!cron) return undefined;
  for (const window of [HOUR, DAY, 32 * DAY, 400 * DAY, Number.POSITIVE_INFINITY]) {
    let latest: number | undefined;
    const start = window === Number.POSITIVE_INFINITY || now - window < after ? after : now - window;
    let at = nextCronAt(cron, start, zone);
    while (at !== undefined && at <= now) {
      latest = at;
      at = nextCronAt(cron, at, zone);
    }
    if (latest !== undefined) return latest;
  }
  return undefined;
}
