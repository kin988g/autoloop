export type TriggerType = "cron" | "webhook" | "manual" | "event";
export type AgentAdapterName = "claude" | "codex" | "cursor" | "command" | "doubao";
export type AgentAccess = "plan" | "acceptEdits" | "bypassPermissions";
export type CardKind = "ask" | "notice";
export type CardStatus = "open" | "decided" | "done" | "closed";
export type RunStatus = "queued" | "claimed" | "running" | "done" | "nothing" | "failed" | "cancelled";
export type RunOutcome = "done" | "nothing" | "failed" | "cancelled";
export type DeliveryStatus = "pending" | "leased" | "delivered" | "failed";

export interface RuleTrigger {
  type: TriggerType;
  cron?: string;
  timezone?: string;
  source?: string;
  eventType?: string;
}

export interface RuleAgent {
  adapter: AgentAdapterName;
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
    feishu?: { enabled: boolean; webhookUrlSecret?: string; appId?: string; appSecretKey?: string };
    webhook?: {
      enabled: boolean;
      preset?: "dingtalk" | "wecom" | "slack" | "discord" | "custom";
      urlSecret?: string;
    };
  };
  sources: {
    github?: { enabled: boolean; webhookSecretKey?: string };
    gitlab?: { enabled: boolean; webhookSecretKey?: string };
  };
}

export interface Receipt {
  ask?: { title: string; body: string; options?: string[] };
  notice?: { title: string; body: string };
  resolve?: { cardId: string; summary?: string };
  later?: { delaySeconds: number; reason: string };
  events?: Array<{ type: string; lane?: string; payload: Record<string, unknown> }>;
}

export interface JobContextEvent {
  id: string;
  type: string;
  source: string;
  payload: unknown;
  createdAt: number;
}

export interface JobAnswer {
  cardId: string;
  choice?: string;
  text?: string;
  answeredAt: number;
}

export interface Job {
  runId: string;
  attempt: number;
  runToken: string;
  rule: Rule;
  lane: string;
  sessionId?: string;
  context: {
    events: JobContextEvent[];
    answer?: JobAnswer;
    openCards: Array<{ id: string; title: string; body: string }>;
  };
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
  answer?: { choice?: string; text?: string; responder?: string; answeredAt: number };
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  id: string;
  type: string;
  source: string;
  lane: string;
  payload: unknown;
  dedupeKey?: string;
  hops: number;
  ruleName?: string;
  runId?: string;
  routed: boolean;
  circuitBroken: boolean;
  createdAt: number;
}

export interface RunRecord {
  id: string;
  ruleName: string;
  lane: string;
  status: RunStatus;
  attempt: number;
  runToken?: string;
  sessionId?: string;
  worker?: string;
  eventIds: string[];
  hops: number;
  outcome?: RunOutcome;
  error?: string;
  usage?: Record<string, number>;
  receipt?: Receipt;
  context?: Job["context"];
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  notBefore?: number;
}

export interface DeliveryRecord {
  id: string;
  cardId: string;
  channel: string;
  status: DeliveryStatus;
  externalId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TimerRecord {
  id: string;
  ruleName: string;
  lane: string;
  runId?: string;
  sessionId?: string;
  fireAt: number;
  reason: string;
  hops: number;
  eventIds: string[];
  fired: boolean;
  createdAt: number;
}

export interface WorkerInfo {
  name: string;
  capacity: number;
  running: string[];
  lastSeenAt: number;
}

export interface HubState {
  config: AppConfig;
  rules: Rule[];
  runs: RunRecord[];
  cards: Card[];
  workers: WorkerInfo[];
  stats: {
    totalRuns: number;
    activeRuns: number;
    openCards: number;
    totalEvents: number;
  };
}

export interface SecretKeyInfo {
  name: string;
  configured: boolean;
}

export type Fact =
  | { type: "event.recorded"; at: number; event: EventRecord }
  | { type: "run.queued"; at: number; run: RunRecord }
  | { type: "run.event-attached"; at: number; runId: string; eventId: string }
  | { type: "run.claimed"; at: number; runId: string; worker: string; attempt: number; runToken: string }
  | { type: "run.started"; at: number; runId: string }
  | {
      type: "run.result";
      at: number;
      runId: string;
      outcome: RunOutcome;
      sessionId?: string;
      receipt?: Receipt;
      error?: string;
      usage?: Record<string, number>;
    }
  | { type: "run.cancelled"; at: number; runId: string }
  | { type: "card.created"; at: number; card: Card }
  | { type: "card.answered"; at: number; cardId: string; answer: NonNullable<Card["answer"]> }
  | { type: "card.resolved"; at: number; cardId: string; summary?: string }
  | { type: "card.done"; at: number; cardId: string }
  | { type: "delivery.queued"; at: number; delivery: DeliveryRecord }
  | { type: "delivery.leased"; at: number; deliveryId: string; channel: string }
  | { type: "delivery.delivered"; at: number; cardId: string; channel: string; externalId?: string }
  | { type: "delivery.failed"; at: number; cardId: string; channel: string; error: string }
  | { type: "timer.created"; at: number; timer: TimerRecord }
  | { type: "timer.fired"; at: number; timerId: string }
  | { type: "rule.paused"; at: number; ruleName: string }
  | { type: "rule.resumed"; at: number; ruleName: string }
  | { type: "rules.replaced"; at: number; rules: Rule[] };

export interface IdCounters {
  event: number;
  run: number;
  card: number;
  delivery: number;
  timer: number;
}

export interface HubView {
  seq: number;
  nextIds: IdCounters;
  rules: Rule[];
  events: EventRecord[];
  runs: RunRecord[];
  cards: Card[];
  deliveries: DeliveryRecord[];
  timers: TimerRecord[];
  pauses: Record<string, number>;
}

export const MAX_HOPS = 8;
export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = 3350;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
