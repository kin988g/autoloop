import type { CronRuleLike } from "./types.ts";

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export interface CronSchedulerOptions {
  timezone?: string;
  pollIntervalMs?: number;
  now?: () => Date;
  onTrigger: (rule: CronRuleLike, firedAt: Date) => void | Promise<void>;
  onError?: (err: unknown, rule?: CronRuleLike) => void;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DEFAULT_TIMEZONE = "Asia/Shanghai";

function cronError(message: string): Error {
  return new Error(`Invalid cron expression: ${message}`);
}

function parseCronNumber(raw: string, min: number, max: number): number {
  if (!/^\d{1,3}$/.test(raw)) {
    throw cronError(`expected a number, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw cronError(`value ${raw} is out of bounds (${min}-${max})`);
  }
  return value;
}

function parseField(
  field: string,
  min: number,
  max: number,
  normalizeDow: boolean,
): Set<number> {
  if (field.length === 0) {
    throw cronError("field must not be empty");
  }
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part.length === 0) {
      throw cronError("list item must not be empty");
    }
    let rangePart = part;
    let step = 1;
    if (part.includes("/")) {
      const pieces = part.split("/");
      if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
        throw cronError(`invalid stepped field "${part}"`);
      }
      rangePart = pieces[0];
      step = parseCronNumber(pieces[1], 1, max);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const pieces = rangePart.split("-");
      if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
        throw cronError(`invalid range "${rangePart}"`);
      }
      start = parseCronNumber(pieces[0], min, max);
      end = parseCronNumber(pieces[1], min, max);
      if (start > end) {
        throw cronError(`range start ${start} is greater than end ${end}`);
      }
    } else {
      start = parseCronNumber(rangePart, min, max);
      end = part.includes("/") ? max : start;
    }
    for (let value = start; value <= end; value += step) {
      if (normalizeDow && value === 7) {
        values.add(0);
      } else {
        values.add(value);
      }
    }
  }
  return values;
}

export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim().length === 0) {
    throw cronError("expression must be a non-empty string");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw cronError(`expected 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw cronError("expected 5 fields");
  }
  return {
    minute: parseField(minute, 0, 59, false),
    hour: parseField(hour, 0, 23, false),
    dayOfMonth: parseField(dayOfMonth, 1, 31, false),
    month: parseField(month, 1, 12, false),
    dayOfWeek: parseField(dayOfWeek, 0, 7, true),
    domRestricted: dayOfMonth !== "*",
    dowRestricted: dayOfWeek !== "*",
  };
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

export function getZonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((item) => item.type === type);
    if (!part) {
      throw new Error(`Unable to read ${type} in timezone ${timezone}`);
    }
    return part.value;
  };
  const hourRaw = Number(read("hour"));
  const weekday = read("weekday");
  const dayOfWeek = WEEKDAYS[weekday];
  if (dayOfWeek === undefined) {
    throw new Error(`Unable to parse weekday "${weekday}"`);
  }
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(read("minute")),
    second: Number(read("second")),
    dayOfWeek,
  };
}

export function formatZonedMinute(parts: ZonedParts): string {
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  const min = String(parts.minute).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export function matchesParsedCron(
  parsed: ParsedCron,
  date: Date,
  timezone: string = DEFAULT_TIMEZONE,
): boolean {
  const parts = getZonedParts(date, timezone);
  if (!parsed.minute.has(parts.minute)) return false;
  if (!parsed.hour.has(parts.hour)) return false;
  if (!parsed.month.has(parts.month)) return false;
  const domMatch = parsed.dayOfMonth.has(parts.day);
  const dowMatch = parsed.dayOfWeek.has(parts.dayOfWeek);
  if (parsed.domRestricted && parsed.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function matchesCron(
  expr: string,
  date: Date,
  timezone: string = DEFAULT_TIMEZONE,
): boolean {
  return matchesParsedCron(parseCron(expr), date, timezone);
}

function dateCanMatch(parsed: ParsedCron, parts: ZonedParts): boolean {
  if (!parsed.month.has(parts.month)) return false;
  const domMatch = parsed.dayOfMonth.has(parts.day);
  const dowMatch = parsed.dayOfWeek.has(parts.dayOfWeek);
  if (parsed.domRestricted && parsed.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

function nextSetValue(values: Set<number>, current: number): number | undefined {
  let next: number | undefined;
  for (const value of values) {
    if (value > current && (next === undefined || value < next)) {
      next = value;
    }
  }
  return next;
}

export function nextCronTime(
  expr: string,
  after: Date,
  timezone: string = DEFAULT_TIMEZONE,
  maxDays: number = 366,
): Date | null {
  const parsed = parseCron(expr);
  let ts = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const end = ts + Math.max(0, maxDays) * 24 * 60 * 60 * 1000;
  while (ts <= end) {
    const candidate = new Date(ts);
    const parts = getZonedParts(candidate, timezone);
    if (matchesParsedCron(parsed, candidate, timezone)) {
      return candidate;
    }
    let jumpMinutes = 1;
    if (!dateCanMatch(parsed, parts)) {
      jumpMinutes = Math.max(1, (23 - parts.hour) * 60 + (60 - parts.minute));
    } else if (!parsed.hour.has(parts.hour)) {
      jumpMinutes = Math.max(1, 60 - parts.minute);
    } else {
      const nextMinute = nextSetValue(parsed.minute, parts.minute);
      jumpMinutes = nextMinute === undefined ? Math.max(1, 60 - parts.minute) : nextMinute - parts.minute;
    }
    ts += jumpMinutes * 60_000;
  }
  return null;
}

const FIRED_TTL_MS = 2 * 60 * 60 * 1000;

export class CronScheduler {
  #timezone: string;
  #pollIntervalMs: number;
  #now: () => Date;
  #onTrigger: (rule: CronRuleLike, firedAt: Date) => void | Promise<void>;
  #onError?: (err: unknown, rule?: CronRuleLike) => void;
  #rules: CronRuleLike[] = [];
  #fired = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(options: CronSchedulerOptions) {
    this.#timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.#pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.#now = options.now ?? (() => new Date());
    this.#onTrigger = options.onTrigger;
    this.#onError = options.onError;
  }

  reload(rules: CronRuleLike[]): void {
    this.#rules = [...rules];
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.#onError?.(err);
      });
    }, this.#pollIntervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#running = false;
  }

  get running(): boolean {
    return this.#running;
  }

  async tick(now?: Date): Promise<string[]> {
    const firedAt = now ?? this.#now();
    const triggered: string[] = [];
    for (const rule of this.#rules) {
      try {
        if (rule.trigger.type !== "cron") continue;
        if (!rule.trigger.cron) continue;
        if (!rule.enabled) continue;
        if (rule.paused === true) continue;
        const timezone = rule.trigger.timezone ?? this.#timezone;
        if (!matchesCron(rule.trigger.cron, firedAt, timezone)) continue;
        const minuteKey = `${rule.name}@${formatZonedMinute(getZonedParts(firedAt, timezone))}`;
        if (this.#fired.has(minuteKey)) continue;
        this.#fired.set(minuteKey, firedAt.getTime());
        triggered.push(rule.name);
        await this.#onTrigger(rule, firedAt);
      } catch (err) {
        this.#onError?.(err, rule);
      }
    }
    this.#pruneFired(firedAt.getTime());
    return triggered;
  }

  #pruneFired(nowMs: number): void {
    for (const [key, timestamp] of this.#fired) {
      if (nowMs - timestamp > FIRED_TTL_MS) {
        this.#fired.delete(key);
      }
    }
  }
}
