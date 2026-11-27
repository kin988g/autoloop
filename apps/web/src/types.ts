/** Defensive TypeScript shapes aligned with CONTRACT.md (packages/protocol and packages/host were empty). */

export type TriggerType = "cron" | "webhook" | "manual" | "event";
export type AgentAdapter = "claude" | "codex" | "cursor" | "command" | "doubao";
export type AgentAccess = "plan" | "acceptEdits" | "bypassPermissions";
export type CardKind = "ask" | "notice";
export type CardStatus = "open" | "decided" | "done" | "closed";
export type WebhookPreset = "dingtalk" | "wecom" | "slack" | "discord" | "custom";
export type RunOutcome = "done" | "nothing" | "failed" | "cancelled";
export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "done"
  | "nothing"
  | "failed"
  | "cancelled";

export interface RuleTrigger {
  type: TriggerType;
  cron?: string;
  timezone?: string;
  source?: string;
  eventType?: string;
}

export interface RuleAgent {
  adapter: AgentAdapter;
  cwd: string;
  access: AgentAccess;
  prompt: string;
  command?: string[];
  timeoutMinutes?: number;
  model?: string;
}

export interface Rule {
  name: string;
  enabled: boolean;
  description?: string;
  trigger: RuleTrigger;
  agent: RuleAgent;
  channels: string[];
  laneKey?: string;
  paused?: boolean;
}

export interface AppConfig {
  hub: {
    host: string;
    port: number;
    publicUrl?: string;
    timezone: string;
  };
  worker: {
    enabled: boolean;
    name: string;
    capacity: number;
    pollTimeoutMs: number;
  };
  agents: {
    claude?: { enabled: boolean; bin?: string; defaultAccess?: string };
    codex?: { enabled: boolean; bin?: string };
    cursor?: { enabled: boolean; bin?: string };
    command?: { enabled: boolean };
    doubao?: { enabled: boolean; baseUrl?: string; model?: string; apiKeySecret?: string };
  };
  channels: {
    web: { enabled: boolean };
    desktop: { enabled: boolean };
    feishu?: {
      enabled: boolean;
      webhookUrlSecret?: string;
      appId?: string;
      appSecretKey?: string;
    };
    webhook?: {
      enabled: boolean;
      preset?: WebhookPreset;
      urlSecret?: string;
    };
  };
  sources: {
    github?: { enabled: boolean; webhookSecretKey?: string };
    gitlab?: { enabled: boolean; webhookSecretKey?: string };
  };
}

export interface CardAnswer {
  choice?: string;
  text?: string;
  responder?: string;
  answeredAt: number;
}

export interface Card {
  id: string;
  runId: string;
  ruleName: string;
  lane: string;
  kind: CardKind;
  status: CardStatus;
  title: string;
  body: string;
  options?: string[];
  answer?: CardAnswer;
  createdAt: number;
  updatedAt: number;
}

/** Aligned with packages/protocol RunRecord; extra fields parsed defensively if present. */
export interface RunRecord {
  id: string;
  ruleName: string;
  status: string;
  lane?: string;
  sessionId?: string;
  outcome?: string;
  attempt?: number;
  hops?: number;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  usage?: Record<string, number>;
  runToken?: string;
  worker?: string;
  eventIds?: string[];
  claimedAt?: number;
  notBefore?: number;
  receipt?: unknown;
}

/** Aligned with packages/protocol WorkerInfo (`running` is a run-id list). */
export interface WorkerInfo {
  name: string;
  connected?: boolean;
  online?: boolean;
  lastSeenAt?: number;
  capacity?: number;
  running: string[];
  busy?: boolean;
}

export interface HubStats {
  totalRuns: number;
  activeRuns: number;
  openCards: number;
  totalEvents: number;
}

export interface HubState {
  config: AppConfig;
  rules: Rule[];
  runs: RunRecord[];
  cards: Card[];
  workers: WorkerInfo[];
  stats: HubStats;
}

export interface Healthz {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

export interface PostEventBody {
  type: string;
  source: string;
  lane?: string;
  payload?: unknown;
  dedupeKey?: string;
  hops?: number;
}

export interface PostEventResult {
  eventId: string;
  runId?: string;
  queued: boolean;
  circuitBroken?: boolean;
}

export interface AnswerCardBody {
  choice?: string;
  text?: string;
  responder?: string;
}

export interface AnswerCardResult {
  ok: boolean;
  resumedRunId?: string;
}

export interface ResolveCardResult {
  ok: boolean;
}

export interface CancelRunResult {
  ok: boolean;
}

export interface RuleActionResult {
  ok: boolean;
  runId?: string;
}

export interface SecretKey {
  name: string;
  configured: boolean;
}

export interface SecretsResult {
  keys: SecretKey[];
}

export interface PutSecretsBody {
  set?: Record<string, string>;
  unset?: string[];
}

export interface SseUpdate {
  type: string;
  at?: number;
  [key: string]: unknown;
}

export interface ApiErrorShape {
  error?: string;
  message?: string;
  status?: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  hub: {
    host: "127.0.0.1",
    port: 3350,
    timezone: "Asia/Shanghai",
  },
  worker: {
    enabled: true,
    name: "worker-1",
    capacity: 2,
    pollTimeoutMs: 30000,
  },
  agents: {
    claude: { enabled: false },
    codex: { enabled: false },
    cursor: { enabled: false },
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
    desktop: { enabled: false },
  },
  sources: {},
};

export const DEFAULT_STATS: HubStats = {
  totalRuns: 0,
  activeRuns: 0,
  openCards: 0,
  totalEvents: 0,
};

export const TRIGGER_TYPES: TriggerType[] = ["cron", "webhook", "manual", "event"];
export const AGENT_ADAPTERS: AgentAdapter[] = ["claude", "codex", "cursor", "command", "doubao"];
export const AGENT_ACCESS: AgentAccess[] = ["plan", "acceptEdits", "bypassPermissions"];
export const CARD_STATUSES: CardStatus[] = ["open", "decided", "done", "closed"];
export const WEBHOOK_PRESETS: WebhookPreset[] = ["dingtalk", "wecom", "slack", "discord", "custom"];
export const CHANNEL_PRESETS = ["web", "desktop", "feishu", "webhook"] as const;

export const COMMON_SECRET_KEYS = [
  "FEISHU_WEBHOOK_URL",
  "FEISHU_APP_SECRET",
  "WEBHOOK_URL",
  "GITHUB_WEBHOOK_SECRET",
  "GITLAB_WEBHOOK_SECRET",
  "ARK_API_KEY",
] as const;

export const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "每分钟", value: "* * * * *" },
  { label: "每 5 分钟", value: "*/5 * * * *" },
  { label: "每小时整点", value: "0 * * * *" },
  { label: "每天 09:00", value: "0 9 * * *" },
  { label: "每天 18:00", value: "0 18 * * *" },
  { label: "每周一 09:00", value: "0 9 * * 1" },
  { label: "工作日 09:00", value: "0 9 * * 1-5" },
];

export function emptyRule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: "",
    enabled: true,
    description: "",
    trigger: { type: "manual", timezone: "Asia/Shanghai" },
    agent: {
      adapter: "claude",
      cwd: ".",
      access: "plan",
      prompt: "",
      timeoutMinutes: 180,
    },
    channels: ["web"],
    paused: false,
    ...overrides,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTriggerType(value: string): value is TriggerType {
  return (TRIGGER_TYPES as string[]).includes(value);
}

function isAdapter(value: string): value is AgentAdapter {
  return (AGENT_ADAPTERS as string[]).includes(value);
}

function isAccess(value: string): value is AgentAccess {
  return (AGENT_ACCESS as string[]).includes(value);
}

function isCardKind(value: string): value is CardKind {
  return value === "ask" || value === "notice";
}

function isCardStatus(value: string): value is CardStatus {
  return (CARD_STATUSES as string[]).includes(value);
}

function isWebhookPreset(value: string): value is WebhookPreset {
  return (WEBHOOK_PRESETS as string[]).includes(value);
}

export function parseTrigger(raw: unknown): RuleTrigger {
  const rec = isRecord(raw) ? raw : {};
  const typeRaw = asString(rec.type, "manual");
  return {
    type: isTriggerType(typeRaw) ? typeRaw : "manual",
    cron: asOptionalString(rec.cron),
    timezone: asOptionalString(rec.timezone),
    source: asOptionalString(rec.source),
    eventType: asOptionalString(rec.eventType),
  };
}

export function parseRuleAgent(raw: unknown): RuleAgent {
  const rec = isRecord(raw) ? raw : {};
  const adapterRaw = asString(rec.adapter, "claude");
  const accessRaw = asString(rec.access, "plan");
  const command = Array.isArray(rec.command)
    ? rec.command.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    adapter: isAdapter(adapterRaw) ? adapterRaw : "claude",
    cwd: asString(rec.cwd, "."),
    access: isAccess(accessRaw) ? accessRaw : "plan",
    prompt: asString(rec.prompt),
    command,
    timeoutMinutes: asOptionalNumber(rec.timeoutMinutes),
    model: asOptionalString(rec.model),
  };
}

export function parseRule(raw: unknown): Rule | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;
  return {
    name,
    enabled: asBoolean(raw.enabled, true),
    description: asOptionalString(raw.description),
    trigger: parseTrigger(raw.trigger),
    agent: parseRuleAgent(raw.agent),
    channels: asStringArray(raw.channels),
    laneKey: asOptionalString(raw.laneKey),
    paused: typeof raw.paused === "boolean" ? raw.paused : undefined,
  };
}

export function parseRules(raw: unknown): Rule[] {
  const list = isRecord(raw) && Array.isArray(raw.rules) ? raw.rules : Array.isArray(raw) ? raw : [];
  return list.map(parseRule).filter((rule): rule is Rule => rule !== null);
}

function parseAgentClaude(raw: unknown): AppConfig["agents"]["claude"] {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    bin: asOptionalString(raw.bin),
    defaultAccess: asOptionalString(raw.defaultAccess),
  };
}

function parseAgentCodex(raw: unknown): AppConfig["agents"]["codex"] {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    bin: asOptionalString(raw.bin),
  };
}

function parseAgentCursor(raw: unknown): AppConfig["agents"]["cursor"] {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    bin: asOptionalString(raw.bin),
  };
}

function parseAgentCommand(raw: unknown): AppConfig["agents"]["command"] {
  if (!isRecord(raw)) return undefined;
  return { enabled: asBoolean(raw.enabled, false) };
}

function parseAgentDoubao(raw: unknown): AppConfig["agents"]["doubao"] {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    baseUrl: asOptionalString(raw.baseUrl),
    model: asOptionalString(raw.model),
    apiKeySecret: asOptionalString(raw.apiKeySecret),
  };
}

function parseFeishu(raw: unknown): NonNullable<AppConfig["channels"]["feishu"]> | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    webhookUrlSecret: asOptionalString(raw.webhookUrlSecret),
    appId: asOptionalString(raw.appId),
    appSecretKey: asOptionalString(raw.appSecretKey),
  };
}

function parseWebhookChannel(raw: unknown): NonNullable<AppConfig["channels"]["webhook"]> | undefined {
  if (!isRecord(raw)) return undefined;
  const presetRaw = asString(raw.preset);
  return {
    enabled: asBoolean(raw.enabled, false),
    preset: isWebhookPreset(presetRaw) ? presetRaw : undefined,
    urlSecret: asOptionalString(raw.urlSecret),
  };
}

function parseSource(
  raw: unknown,
): { enabled: boolean; webhookSecretKey?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    enabled: asBoolean(raw.enabled, false),
    webhookSecretKey: asOptionalString(raw.webhookSecretKey),
  };
}

export function parseAppConfig(raw: unknown): AppConfig {
  const rec = isRecord(raw) ? raw : isRecord(raw) === false && isRecord((raw as { config?: unknown })?.config)
    ? ((raw as { config: unknown }).config as Record<string, unknown>)
    : {};
  const source = isRecord(raw) && isRecord(raw.config) ? raw.config : rec;
  const hub = isRecord(source.hub) ? source.hub : {};
  const worker = isRecord(source.worker) ? source.worker : {};
  const agents = isRecord(source.agents) ? source.agents : {};
  const channels = isRecord(source.channels) ? source.channels : {};
  const sources = isRecord(source.sources) ? source.sources : {};
  const web = isRecord(channels.web) ? channels.web : {};
  const desktop = isRecord(channels.desktop) ? channels.desktop : {};

  return {
    hub: {
      host: asString(hub.host, DEFAULT_CONFIG.hub.host),
      port: asNumber(hub.port, DEFAULT_CONFIG.hub.port),
      publicUrl: asOptionalString(hub.publicUrl),
      timezone: asString(hub.timezone, DEFAULT_CONFIG.hub.timezone),
    },
    worker: {
      enabled: asBoolean(worker.enabled, DEFAULT_CONFIG.worker.enabled),
      name: asString(worker.name, DEFAULT_CONFIG.worker.name),
      capacity: asNumber(worker.capacity, DEFAULT_CONFIG.worker.capacity),
      pollTimeoutMs: asNumber(worker.pollTimeoutMs, DEFAULT_CONFIG.worker.pollTimeoutMs),
    },
    agents: {
      claude: parseAgentClaude(agents.claude) ?? { enabled: false },
      codex: parseAgentCodex(agents.codex) ?? { enabled: false },
      cursor: parseAgentCursor(agents.cursor) ?? { enabled: false },
      command: parseAgentCommand(agents.command) ?? { enabled: false },
      doubao: parseAgentDoubao(agents.doubao) ?? {
        enabled: false,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seed-1-6-250615",
        apiKeySecret: "ARK_API_KEY",
      },
    },
    channels: {
      web: { enabled: asBoolean(web.enabled, true) },
      desktop: { enabled: asBoolean(desktop.enabled, false) },
      feishu: parseFeishu(channels.feishu),
      webhook: parseWebhookChannel(channels.webhook),
    },
    sources: {
      github: parseSource(sources.github),
      gitlab: parseSource(sources.gitlab),
    },
  };
}

export function parseCard(raw: unknown): Card | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const kindRaw = asString(raw.kind, "notice");
  const statusRaw = asString(raw.status, "open");
  const answerRaw = isRecord(raw.answer) ? raw.answer : null;
  return {
    id,
    runId: asString(raw.runId),
    ruleName: asString(raw.ruleName),
    lane: asString(raw.lane),
    kind: isCardKind(kindRaw) ? kindRaw : "notice",
    status: isCardStatus(statusRaw) ? statusRaw : "open",
    title: asString(raw.title, "(无标题)"),
    body: asString(raw.body),
    options: asStringArray(raw.options),
    answer: answerRaw
      ? {
          choice: asOptionalString(answerRaw.choice),
          text: asOptionalString(answerRaw.text),
          responder: asOptionalString(answerRaw.responder),
          answeredAt: asNumber(answerRaw.answeredAt, 0),
        }
      : undefined,
    createdAt: asNumber(raw.createdAt, 0),
    updatedAt: asNumber(raw.updatedAt, 0),
  };
}

export function parseCards(raw: unknown): Card[] {
  const list = isRecord(raw) && Array.isArray(raw.cards) ? raw.cards : Array.isArray(raw) ? raw : [];
  return list.map(parseCard).filter((card): card is Card => card !== null);
}

export function parseRun(raw: unknown): RunRecord | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id) || asString(raw.runId);
  if (!id) return null;
  const usageRaw = isRecord(raw.usage) ? raw.usage : undefined;
  const usage: Record<string, number> | undefined = usageRaw
    ? Object.fromEntries(
        Object.entries(usageRaw).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : undefined;
  const ruleName =
    asString(raw.ruleName) ||
    (isRecord(raw.rule) ? asString(raw.rule.name) : "") ||
    asString(raw.rule);
  return {
    id,
    ruleName,
    status: asString(raw.status) || asString(raw.state) || asString(raw.outcome) || "unknown",
    lane: asOptionalString(raw.lane),
    sessionId: asOptionalString(raw.sessionId),
    outcome: asOptionalString(raw.outcome),
    attempt: asOptionalNumber(raw.attempt),
    hops: asOptionalNumber(raw.hops),
    error: asOptionalString(raw.error) || asOptionalString(raw.message),
    createdAt: asOptionalNumber(raw.createdAt),
    updatedAt: asOptionalNumber(raw.updatedAt),
    startedAt: asOptionalNumber(raw.startedAt),
    finishedAt: asOptionalNumber(raw.finishedAt) ?? asOptionalNumber(raw.endedAt),
    usage,
    runToken: asOptionalString(raw.runToken),
    worker: asOptionalString(raw.worker),
    eventIds: asStringArray(raw.eventIds),
    claimedAt: asOptionalNumber(raw.claimedAt),
    notBefore: asOptionalNumber(raw.notBefore),
    receipt: raw.receipt,
  };
}

export function parseRuns(raw: unknown): RunRecord[] {
  const list = isRecord(raw) && Array.isArray(raw.runs) ? raw.runs : Array.isArray(raw) ? raw : [];
  return list.map(parseRun).filter((run): run is RunRecord => run !== null);
}

export function parseWorker(raw: unknown): WorkerInfo | null {
  if (typeof raw === "string" && raw.trim()) {
    return { name: raw.trim(), connected: true, running: [] };
  }
  if (!isRecord(raw)) return null;
  const name = asString(raw.name) || asString(raw.id) || asString(raw.worker) || asString(raw.workerName);
  if (!name) return null;
  const runningIds = [
    ...asStringArray(raw.running),
    ...asStringArray(raw.currentRuns),
    ...asStringArray(raw.runningIds),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const connected =
    typeof raw.connected === "boolean"
      ? raw.connected
      : typeof raw.online === "boolean"
        ? raw.online
        : typeof raw.alive === "boolean"
          ? raw.alive
          : true;
  return {
    name,
    connected,
    online: typeof raw.online === "boolean" ? raw.online : connected,
    lastSeenAt: asOptionalNumber(raw.lastSeenAt) ?? asOptionalNumber(raw.seenAt) ?? asOptionalNumber(raw.heartbeatAt),
    capacity: asOptionalNumber(raw.capacity),
    running: runningIds,
    busy: typeof raw.busy === "boolean" ? raw.busy : undefined,
  };
}

export function parseWorkers(raw: unknown): WorkerInfo[] {
  const list = isRecord(raw) && Array.isArray(raw.workers) ? raw.workers : Array.isArray(raw) ? raw : [];
  return list.map(parseWorker).filter((worker): worker is WorkerInfo => worker !== null);
}

export function parseStats(raw: unknown): HubStats {
  const rec = isRecord(raw) ? raw : {};
  return {
    totalRuns: asNumber(rec.totalRuns, 0),
    activeRuns: asNumber(rec.activeRuns, 0),
    openCards: asNumber(rec.openCards, 0),
    totalEvents: asNumber(rec.totalEvents, 0),
  };
}

export function parseHealth(raw: unknown): Healthz {
  const rec = isRecord(raw) ? raw : {};
  return {
    ok: asBoolean(rec.ok, false),
    version: asString(rec.version, "unknown"),
    uptimeMs: asNumber(rec.uptimeMs, 0),
  };
}

export function parseHubState(raw: unknown): HubState {
  const rec = isRecord(raw) ? raw : {};
  return {
    config: parseAppConfig(isRecord(rec.config) ? rec.config : rec),
    rules: parseRules(Array.isArray(rec.rules) ? { rules: rec.rules } : rec.rules),
    runs: parseRuns(Array.isArray(rec.runs) ? { runs: rec.runs } : rec.runs),
    cards: parseCards(Array.isArray(rec.cards) ? { cards: rec.cards } : rec.cards),
    workers: parseWorkers(Array.isArray(rec.workers) ? { workers: rec.workers } : rec.workers),
    stats: parseStats(rec.stats),
  };
}

export function parseSecretKeys(raw: unknown): SecretKey[] {
  const list = isRecord(raw) && Array.isArray(raw.keys) ? raw.keys : Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        return { name: item.trim(), configured: true };
      }
      if (!isRecord(item)) return null;
      const name = asString(item.name) || asString(item.key);
      if (!name) return null;
      return { name, configured: asBoolean(item.configured, true) };
    })
    .filter((item): item is SecretKey => item !== null);
}

export function parseSseUpdate(raw: unknown): SseUpdate | null {
  if (typeof raw === "string") {
    try {
      return parseSseUpdate(JSON.parse(raw) as unknown);
    } catch {
      return { type: "update" };
    }
  }
  if (!isRecord(raw)) return null;
  return {
    ...raw,
    type: asString(raw.type, "update"),
    at: asOptionalNumber(raw.at),
  };
}

export function parseErrorMessage(raw: unknown, fallback = "请求失败"): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (!isRecord(raw)) return fallback;
  const message = asOptionalString(raw.error) || asOptionalString(raw.message) || asOptionalString(raw.detail);
  return message || fallback;
}

export function isActiveRunStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "queued" ||
    normalized === "claimed" ||
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "started" ||
    normalized === "in_progress" ||
    normalized === "active"
  );
}

export function cloneConfig(config: AppConfig): AppConfig {
  return structuredClone(config);
}

export function cloneRules(rules: Rule[]): Rule[] {
  return structuredClone(rules);
}
