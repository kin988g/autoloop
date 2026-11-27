import { parseCron, isValidTimeZone } from "./cron.ts";
import type { AppConfig, Receipt, Rule, RuleAgent, RuleTrigger } from "./types.ts";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, DEFAULT_TIMEZONE } from "./types.ts";

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function fail<T>(error: string): Validation<T> {
  return { ok: false, error };
}

export function defaultAppConfig(): AppConfig {
  return {
    hub: {
      host: DEFAULT_HUB_HOST,
      port: DEFAULT_HUB_PORT,
      timezone: DEFAULT_TIMEZONE,
    },
    worker: {
      enabled: true,
      name: "local",
      capacity: 2,
      pollTimeoutMs: 30_000,
    },
    agents: {
      claude: { enabled: true },
      codex: { enabled: true },
      cursor: { enabled: true },
      command: { enabled: true },
      doubao: {
        enabled: false,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seed-1-6-250615",
        apiKeySecret: "ARK_API_KEY",
      },
    },
    channels: {
      web: { enabled: true },
      desktop: { enabled: true },
    },
    sources: {},
  };
}

const TRIGGER_TYPES = new Set(["cron", "webhook", "manual", "event"]);
const ADAPTERS = new Set(["claude", "codex", "cursor", "command", "doubao"]);
const ACCESS = new Set(["plan", "acceptEdits", "bypassPermissions"]);

function validateTrigger(raw: unknown, ruleName: string): Validation<RuleTrigger> {
  if (!isObject(raw)) return fail(`${ruleName}: trigger must be an object`);
  if (!isString(raw.type) || !TRIGGER_TYPES.has(raw.type)) {
    return fail(`${ruleName}: trigger.type must be cron, webhook, manual, or event`);
  }
  const trigger: RuleTrigger = { type: raw.type as RuleTrigger["type"] };
  if (raw.cron !== undefined) {
    if (!isString(raw.cron) || !parseCron(raw.cron)) return fail(`${ruleName}: trigger.cron must be a 5-field expression`);
    trigger.cron = raw.cron.trim();
  }
  if (raw.timezone !== undefined) {
    if (!isString(raw.timezone) || !isValidTimeZone(raw.timezone)) return fail(`${ruleName}: trigger.timezone is invalid`);
    trigger.timezone = raw.timezone;
  }
  if (raw.source !== undefined) {
    if (!isString(raw.source) || !raw.source.trim()) return fail(`${ruleName}: trigger.source must be a string`);
    trigger.source = raw.source;
  }
  if (raw.eventType !== undefined) {
    if (!isString(raw.eventType) || !raw.eventType.trim()) return fail(`${ruleName}: trigger.eventType must be a string`);
    trigger.eventType = raw.eventType;
  }
  if (trigger.type === "cron" && !trigger.cron) return fail(`${ruleName}: cron trigger requires trigger.cron`);
  return { ok: true, value: trigger };
}

function validateAgent(raw: unknown, ruleName: string): Validation<RuleAgent> {
  if (!isObject(raw)) return fail(`${ruleName}: agent must be an object`);
  if (!isString(raw.adapter) || !ADAPTERS.has(raw.adapter)) {
    return fail(`${ruleName}: agent.adapter must be claude, codex, cursor, command, or doubao`);
  }
  if (!isString(raw.cwd) || !raw.cwd.trim()) return fail(`${ruleName}: agent.cwd is required`);
  if (!isString(raw.access) || !ACCESS.has(raw.access)) {
    return fail(`${ruleName}: agent.access must be plan, acceptEdits, or bypassPermissions`);
  }
  if (!isString(raw.prompt)) return fail(`${ruleName}: agent.prompt must be a string`);
  const agent: RuleAgent = {
    adapter: raw.adapter as RuleAgent["adapter"],
    cwd: raw.cwd,
    access: raw.access as RuleAgent["access"],
    prompt: raw.prompt,
  };
  if (raw.command !== undefined) {
    if (!Array.isArray(raw.command) || !raw.command.every((item) => isString(item))) {
      return fail(`${ruleName}: agent.command must be a string array`);
    }
    agent.command = raw.command as string[];
  }
  if (raw.model !== undefined) {
    if (!isString(raw.model)) return fail(`${ruleName}: agent.model must be a string`);
    if (raw.model.trim()) agent.model = raw.model.trim();
  }
  if (raw.timeoutMinutes !== undefined) {
    if (!isNumber(raw.timeoutMinutes) || raw.timeoutMinutes <= 0) {
      return fail(`${ruleName}: agent.timeoutMinutes must be a positive number`);
    }
    agent.timeoutMinutes = raw.timeoutMinutes;
  } else {
    agent.timeoutMinutes = 180;
  }
  if (agent.adapter === "command" && (!agent.command || agent.command.length === 0)) {
    return fail(`${ruleName}: command adapter requires agent.command`);
  }
  return { ok: true, value: agent };
}

export function validateRule(rule: unknown): Validation<Rule> {
  if (!isObject(rule)) return fail("rule must be an object");
  if (!isString(rule.name) || !rule.name.trim()) return fail("rule.name is required");
  const name = rule.name.trim();
  const enabled = rule.enabled === undefined ? true : rule.enabled;
  if (!isBoolean(enabled)) return fail(`${name}: enabled must be a boolean`);
  if (rule.description !== undefined && !isString(rule.description)) return fail(`${name}: description must be a string`);
  const trigger = validateTrigger(rule.trigger, name);
  if (!trigger.ok) return trigger;
  const agent = validateAgent(rule.agent, name);
  if (!agent.ok) return agent;
  let channels: string[] = [];
  if (rule.channels !== undefined) {
    if (!Array.isArray(rule.channels) || !rule.channels.every((item) => isString(item))) {
      return fail(`${name}: channels must be a string array`);
    }
    channels = rule.channels as string[];
  }
  if (rule.laneKey !== undefined && !isString(rule.laneKey)) return fail(`${name}: laneKey must be a string`);
  if (rule.paused !== undefined && !isBoolean(rule.paused)) return fail(`${name}: paused must be a boolean`);
  const value: Rule = {
    name,
    enabled,
    trigger: trigger.value,
    agent: agent.value,
    channels,
  };
  if (rule.description !== undefined) value.description = rule.description as string;
  if (rule.laneKey !== undefined) value.laneKey = rule.laneKey as string;
  if (rule.paused !== undefined) value.paused = rule.paused as boolean;
  return { ok: true, value };
}

export function validateRules(data: unknown): Validation<Rule[]> {
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (isObject(data) && Array.isArray(data.rules)) list = data.rules;
  else return fail("rules must be an array or { rules: Rule[] }");
  const rules: Rule[] = [];
  const names = new Set<string>();
  for (const item of list as unknown[]) {
    const result = validateRule(item);
    if (!result.ok) return result;
    if (names.has(result.value.name)) return fail(`duplicate rule name: ${result.value.name}`);
    names.add(result.value.name);
    rules.push(result.value);
  }
  return { ok: true, value: rules };
}

function mergeEnabled(raw: unknown, fallback: { enabled: boolean }): { enabled: boolean } & Record<string, unknown> {
  const src = isObject(raw) ? raw : {};
  return { ...fallback, ...src, enabled: isBoolean(src.enabled) ? src.enabled : (fallback.enabled ?? false) };
}

export function validateAppConfig(data: unknown): Validation<AppConfig> {
  if (data === undefined || data === null) return { ok: true, value: defaultAppConfig() };
  if (!isObject(data)) return fail("config must be an object");
  const defaults = defaultAppConfig();
  const hubRaw = isObject(data.hub) ? data.hub : {};
  const host = isString(hubRaw.host) && hubRaw.host.trim() ? hubRaw.host : defaults.hub.host;
  const port = isNumber(hubRaw.port) ? hubRaw.port : defaults.hub.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("hub.port must be an integer 0-65535");
  const timezone = isString(hubRaw.timezone) && hubRaw.timezone.trim() ? hubRaw.timezone : defaults.hub.timezone;
  if (!isValidTimeZone(timezone)) return fail("hub.timezone is invalid");
  const publicUrl = hubRaw.publicUrl;
  if (publicUrl !== undefined && !isString(publicUrl)) return fail("hub.publicUrl must be a string");

  const workerRaw = isObject(data.worker) ? data.worker : {};
  const workerEnabled = workerRaw.enabled === undefined ? defaults.worker.enabled : workerRaw.enabled;
  if (!isBoolean(workerEnabled)) return fail("worker.enabled must be a boolean");
  const workerName = isString(workerRaw.name) && workerRaw.name.trim() ? workerRaw.name : defaults.worker.name;
  const capacity = isNumber(workerRaw.capacity) ? workerRaw.capacity : defaults.worker.capacity;
  if (!Number.isInteger(capacity) || capacity < 1) return fail("worker.capacity must be a positive integer");
  const pollTimeoutMs = isNumber(workerRaw.pollTimeoutMs) ? workerRaw.pollTimeoutMs : defaults.worker.pollTimeoutMs;
  if (!Number.isInteger(pollTimeoutMs) || pollTimeoutMs < 0) return fail("worker.pollTimeoutMs must be a non-negative integer");

  const agentsRaw = isObject(data.agents) ? data.agents : {};
  const channelsRaw = isObject(data.channels) ? data.channels : {};
  const sourcesRaw = isObject(data.sources) ? data.sources : {};

  const config: AppConfig = {
    hub: { host, port, timezone },
    worker: { enabled: workerEnabled, name: workerName, capacity, pollTimeoutMs },
    agents: {
      claude: mergeEnabled(agentsRaw.claude, defaults.agents.claude ?? { enabled: true }) as AppConfig["agents"]["claude"],
      codex: mergeEnabled(agentsRaw.codex, defaults.agents.codex ?? { enabled: true }) as AppConfig["agents"]["codex"],
      cursor: mergeEnabled(agentsRaw.cursor, defaults.agents.cursor ?? { enabled: true }) as AppConfig["agents"]["cursor"],
      command: mergeEnabled(agentsRaw.command, defaults.agents.command ?? { enabled: true }) as AppConfig["agents"]["command"],
      doubao: mergeEnabled(
        agentsRaw.doubao,
        defaults.agents.doubao ?? {
          enabled: false,
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          model: "doubao-seed-1-6-250615",
          apiKeySecret: "ARK_API_KEY",
        },
      ) as AppConfig["agents"]["doubao"],
    },
    channels: {
      web: mergeEnabled(channelsRaw.web, defaults.channels.web) as AppConfig["channels"]["web"],
      desktop: mergeEnabled(channelsRaw.desktop, defaults.channels.desktop) as AppConfig["channels"]["desktop"],
    },
    sources: {},
  };
  if (isString(publicUrl) && publicUrl) config.hub.publicUrl = publicUrl;
  if (channelsRaw.feishu !== undefined) {
    if (!isObject(channelsRaw.feishu)) return fail("channels.feishu must be an object");
    config.channels.feishu = mergeEnabled(channelsRaw.feishu, { enabled: false }) as NonNullable<AppConfig["channels"]["feishu"]>;
  }
  if (channelsRaw.webhook !== undefined) {
    if (!isObject(channelsRaw.webhook)) return fail("channels.webhook must be an object");
    const preset = channelsRaw.webhook.preset;
    if (preset !== undefined && !["dingtalk", "wecom", "slack", "discord", "custom"].includes(String(preset))) {
      return fail("channels.webhook.preset is invalid");
    }
    config.channels.webhook = mergeEnabled(channelsRaw.webhook, { enabled: false }) as NonNullable<AppConfig["channels"]["webhook"]>;
  }
  if (sourcesRaw.github !== undefined) {
    if (!isObject(sourcesRaw.github)) return fail("sources.github must be an object");
    config.sources.github = mergeEnabled(sourcesRaw.github, { enabled: false }) as NonNullable<AppConfig["sources"]["github"]>;
  }
  if (sourcesRaw.gitlab !== undefined) {
    if (!isObject(sourcesRaw.gitlab)) return fail("sources.gitlab must be an object");
    config.sources.gitlab = mergeEnabled(sourcesRaw.gitlab, { enabled: false }) as NonNullable<AppConfig["sources"]["gitlab"]>;
  }
  return { ok: true, value: config };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

export function validateReceipt(data: unknown): Validation<Receipt> {
  if (!isRecord(data)) return fail("receipt must be an object");
  const receipt: Receipt = {};
  if (data.ask !== undefined) {
    if (!isRecord(data.ask) || !isString(data.ask.title) || !isString(data.ask.body)) {
      return fail("receipt.ask requires title and body");
    }
    const ask: NonNullable<Receipt["ask"]> = { title: data.ask.title, body: data.ask.body };
    if (data.ask.options !== undefined) {
      if (!Array.isArray(data.ask.options) || !data.ask.options.every((item) => isString(item))) {
        return fail("receipt.ask.options must be a string array");
      }
      ask.options = data.ask.options as string[];
    }
    receipt.ask = ask;
  }
  if (data.notice !== undefined) {
    if (!isRecord(data.notice) || !isString(data.notice.title) || !isString(data.notice.body)) {
      return fail("receipt.notice requires title and body");
    }
    receipt.notice = { title: data.notice.title, body: data.notice.body };
  }
  if (data.resolve !== undefined) {
    if (!isRecord(data.resolve) || !isString(data.resolve.cardId)) return fail("receipt.resolve requires cardId");
    const resolve: NonNullable<Receipt["resolve"]> = { cardId: data.resolve.cardId };
    if (data.resolve.summary !== undefined) {
      if (!isString(data.resolve.summary)) return fail("receipt.resolve.summary must be a string");
      resolve.summary = data.resolve.summary;
    }
    receipt.resolve = resolve;
  }
  if (data.later !== undefined) {
    if (!isRecord(data.later) || !isNumber(data.later.delaySeconds) || data.later.delaySeconds < 0 || !isString(data.later.reason)) {
      return fail("receipt.later requires non-negative delaySeconds and reason");
    }
    receipt.later = { delaySeconds: data.later.delaySeconds, reason: data.later.reason };
  }
  if (data.events !== undefined) {
    if (!Array.isArray(data.events)) return fail("receipt.events must be an array");
    const events: NonNullable<Receipt["events"]> = [];
    for (const item of data.events) {
      if (!isRecord(item) || !isString(item.type) || !item.type.trim()) return fail("receipt.events[].type is required");
      if (item.lane !== undefined && !isString(item.lane)) return fail("receipt.events[].lane must be a string");
      const payload = item.payload === undefined ? {} : item.payload;
      if (!isRecord(payload)) return fail("receipt.events[].payload must be an object");
      const ev: NonNullable<Receipt["events"]>[number] = { type: item.type, payload };
      if (isString(item.lane)) ev.lane = item.lane;
      events.push(ev);
    }
    receipt.events = events;
  }
  return { ok: true, value: receipt };
}

const FENCE = /```agent-autoloop[^\n]*\n([\s\S]*?)```/g;

export function parseReceipt(text: string): Receipt | undefined {
  if (typeof text !== "string" || !text.includes("agent-autoloop")) return undefined;
  let last: string | undefined;
  const re = new RegExp(FENCE.source, "g");
  for (const match of text.matchAll(re)) last = match[1];
  if (last === undefined) return undefined;
  try {
    const parsed = JSON.parse(last);
    const result = validateReceipt(parsed);
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}
