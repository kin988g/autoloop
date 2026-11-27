import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decide, buildJob, DecisionError, type DecisionInput } from "../kernel/decide.ts";
import { emptyView, evolve, ProjectionChanges } from "../kernel/evolve.ts";
import { nextCronAt } from "../kernel/cron.ts";
import { ruleByName } from "../kernel/rules.ts";
import type {
  AppConfig,
  Card,
  EventRecord,
  Fact,
  HubState,
  HubView,
  Job,
  Rule,
  RunRecord,
  SecretKeyInfo,
  WorkerInfo,
} from "../protocol/types.ts";
import { defaultAppConfig, validateAppConfig, validateRules } from "../protocol/validate.ts";
import {
  DB_FILE,
  ensureDir,
  loadConfig,
  loadRules,
  loadSecrets,
  resolveDataDir,
  saveConfig,
  saveRules,
  saveSecrets,
  secretList,
} from "./files.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS fact_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  fact TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  lane TEXT NOT NULL,
  payload TEXT,
  dedupe_key TEXT,
  hops INTEGER NOT NULL DEFAULT 0,
  rule_name TEXT,
  run_id TEXT,
  routed INTEGER NOT NULL DEFAULT 0,
  circuit_broken INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  run_token TEXT,
  session_id TEXT,
  worker TEXT,
  event_ids TEXT NOT NULL,
  hops INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  error TEXT,
  usage TEXT,
  receipt TEXT,
  context TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  not_before INTEGER
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  options TEXT,
  answer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL,
  lane TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  fire_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  hops INTEGER NOT NULL DEFAULT 0,
  event_ids TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pauses (
  rule_name TEXT PRIMARY KEY,
  paused_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type RuntimeOptions = {
  dataDir?: string;
  clock?: () => number;
};

export type ChangeListener = (facts: Fact[], input: DecisionInput, now: number) => void;

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export class Runtime {
  readonly dataDir: string;
  readonly memory: boolean;
  private db: DatabaseSync;
  private clock: () => number;
  view: HubView;
  config: AppConfig;
  secrets: Record<string, string>;
  rulesError: string | undefined;
  workers: Map<string, WorkerInfo>;
  private listeners: Set<ChangeListener>;
  private configListeners: Set<() => void>;
  private cronTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private schedulersOn = false;
  private closed = false;
  private nextCronDue: number | undefined;

  constructor(options: RuntimeOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.memory = this.dataDir === ":memory:";
    this.clock = options.clock ?? Date.now;
    this.listeners = new Set();
    this.configListeners = new Set();
    this.workers = new Map();
    if (!this.memory) ensureDir(this.dataDir);
    const dbPath = this.memory ? ":memory:" : join(this.dataDir, DB_FILE);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.config = this.memory ? defaultAppConfig() : loadConfig(this.dataDir);
    const loaded = this.memory ? { rules: [] as Rule[] } : loadRules(this.dataDir);
    this.rulesError = loaded.error;
    this.secrets = this.memory ? {} : loadSecrets(this.dataDir);
    this.view = emptyView(loaded.rules);
    this.rebuild();
  }

  now(): number {
    return this.clock();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConfigChange(listener: () => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  private notifyConfig(): void {
    for (const listener of this.configListeners) listener();
  }

  private upsert(table: string, columns: string) {
    const names = columns.split(",");
    const updates = names.slice(1).map(name => `${name}=excluded.${name}`);
    return this.db.prepare(`INSERT INTO ${table}(${columns}) VALUES (${names.map(() => "?").join(",")})
      ON CONFLICT(${names[0]}) DO UPDATE SET ${updates.join(",")}`);
  }

  private persistView(view: HubView, changes?: ProjectionChanges): void {
    if (!changes) this.db.exec(`
      DELETE FROM events;
      DELETE FROM runs;
      DELETE FROM cards;
      DELETE FROM deliveries;
      DELETE FROM timers;
      DELETE FROM pauses;
    `);
    const ev = this.upsert("events", "id,type,source,lane,payload,dedupe_key,hops,rule_name,run_id,routed,circuit_broken,created_at");
    for (const event of changes?.events.values() ?? view.events) {
      ev.run(
        event.id,
        event.type,
        event.source,
        event.lane,
        json(event.payload ?? null),
        event.dedupeKey ?? null,
        event.hops,
        event.ruleName ?? null,
        event.runId ?? null,
        event.routed ? 1 : 0,
        event.circuitBroken ? 1 : 0,
        event.createdAt,
      );
    }
    const rn = this.upsert("runs", "id,rule_name,lane,status,attempt,run_token,session_id,worker,event_ids,hops,outcome,error,usage,receipt,context,created_at,updated_at,claimed_at,started_at,finished_at,not_before");
    for (const run of changes?.runs.values() ?? view.runs) {
      rn.run(
        run.id,
        run.ruleName,
        run.lane,
        run.status,
        run.attempt,
        run.runToken ?? null,
        run.sessionId ?? null,
        run.worker ?? null,
        json(run.eventIds),
        run.hops,
        run.outcome ?? null,
        run.error ?? null,
        run.usage ? json(run.usage) : null,
        run.receipt ? json(run.receipt) : null,
        run.context ? json(run.context) : null,
        run.createdAt,
        run.updatedAt,
        run.claimedAt ?? null,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.notBefore ?? null,
      );
    }
    const cd = this.upsert("cards", "id,run_id,rule_name,lane,kind,status,title,body,options,answer,created_at,updated_at");
    for (const card of changes?.cards.values() ?? view.cards) {
      cd.run(
        card.id,
        card.runId,
        card.ruleName,
        card.lane,
        card.kind,
        card.status,
        card.title,
        card.body,
        card.options ? json(card.options) : null,
        card.answer ? json(card.answer) : null,
        card.createdAt,
        card.updatedAt,
      );
    }
    const dl = this.upsert("deliveries", "id,card_id,channel,status,external_id,error,created_at,updated_at");
    for (const delivery of changes?.deliveries.values() ?? view.deliveries) {
      dl.run(
        delivery.id,
        delivery.cardId,
        delivery.channel,
        delivery.status,
        delivery.externalId ?? null,
        delivery.error ?? null,
        delivery.createdAt,
        delivery.updatedAt,
      );
    }
    const tm = this.upsert("timers", "id,rule_name,lane,run_id,session_id,fire_at,reason,hops,event_ids,fired,created_at");
    for (const timer of changes?.timers.values() ?? view.timers) {
      tm.run(
        timer.id,
        timer.ruleName,
        timer.lane,
        timer.runId ?? null,
        timer.sessionId ?? null,
        timer.fireAt,
        timer.reason,
        timer.hops,
        json(timer.eventIds),
        timer.fired ? 1 : 0,
        timer.createdAt,
      );
    }
    const ps = this.upsert("pauses", "rule_name,paused_at");
    for (const name of changes?.pauses ?? Object.keys(view.pauses)) {
      if (Object.hasOwn(view.pauses, name)) ps.run(name, view.pauses[name]);
      else this.db.prepare("DELETE FROM pauses WHERE rule_name=?").run(name);
    }
  }

  rebuild(): HubView {
    const rows = this.db.prepare("SELECT fact FROM fact_log ORDER BY seq").all();
    const facts = rows.map((row) => JSON.parse(String(row.fact)) as Fact);
    const rules = this.view.rules;
    const view = evolve(emptyView(rules), facts);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.persistView(view);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.view = view;
    return view;
  }

  commit(input: DecisionInput, now = this.now()): { facts: Fact[]; view: HubView } {
    if (this.closed) throw new Error("runtime is closed");
    const facts = decide(this.view, input, now);
    if (!facts.length) return { facts, view: this.view };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare("INSERT INTO fact_log(at, type, fact) VALUES (?,?,?)");
      for (const fact of facts) insert.run(fact.at, fact.type, json(fact));
      const changes = new ProjectionChanges();
      const view = evolve(this.view, facts, changes);
      this.persistView(view, changes);
      this.db.exec("COMMIT");
      this.view = view;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.listeners) listener(facts, input, now);
    return { facts, view: this.view };
  }

  existingEventByDedupe(key: string): EventRecord | undefined {
    return this.view.events.find((event) => event.dedupeKey === key);
  }

  ingest(event: {
    type: string;
    source: string;
    lane?: string;
    payload?: unknown;
    dedupeKey?: string;
    hops?: number;
  }, now = this.now()) {
    if (event.dedupeKey) {
      const existing = this.existingEventByDedupe(event.dedupeKey);
      if (existing) {
        return {
          eventId: existing.id,
          runId: existing.runId,
          queued: false,
          circuitBroken: existing.circuitBroken || undefined,
          facts: [] as Fact[],
        };
      }
    }
    const { facts } = this.commit({ type: "event", event }, now);
    const recorded = facts.find((fact) => fact.type === "event.recorded");
    const queued = facts.find((fact) => fact.type === "run.queued");
    const attached = facts.find((fact) => fact.type === "run.event-attached");
    const eventId = recorded && recorded.type === "event.recorded" ? recorded.event.id : "";
    const runId =
      queued && queued.type === "run.queued"
        ? queued.run.id
        : attached && attached.type === "run.event-attached"
          ? attached.runId
          : undefined;
    const circuitBroken = recorded && recorded.type === "event.recorded" ? recorded.event.circuitBroken : false;
    return { eventId, runId, queued: Boolean(runId) && !circuitBroken, circuitBroken: circuitBroken || undefined, facts };
  }

  claim(worker: string, capacity: number, running: string[], now = this.now()): Job | null {
    this.touchWorker(worker, capacity, running, now);
    const { facts } = this.commit({ type: "claim", worker, capacity, running }, now);
    const claimed = facts.find((fact) => fact.type === "run.claimed");
    if (!claimed || claimed.type !== "run.claimed") return null;
    const run = this.view.runs.find((item) => item.id === claimed.runId);
    if (!run) return null;
    return buildJob(this.view, run) ?? null;
  }

  started(runId: string, runToken?: string, now = this.now()) {
    return this.commit({ type: "started", runId, runToken }, now);
  }

  result(
    runId: string,
    body: {
      outcome: "done" | "nothing" | "failed" | "cancelled";
      sessionId?: string;
      receipt?: import("../protocol/types.ts").Receipt;
      error?: string;
      usage?: Record<string, number>;
      runToken?: string;
    },
    now = this.now(),
  ) {
    const { facts, view } = this.commit({ type: "result", runId, ...body }, now);
    return {
      facts,
      view,
      cardId: view.cards.find(item => item.runId === runId)?.id,
    };
  }

  cancel(runId: string, now = this.now()) {
    return this.commit({ type: "cancel", runId }, now);
  }

  lease(channel: string, now = this.now()) {
    const { facts, view } = this.commit({ type: "lease", channel }, now);
    const leased = facts.find((fact) => fact.type === "delivery.leased");
    if (!leased || leased.type !== "delivery.leased") return { delivery: null as null };
    const delivery = view.deliveries.find((item) => item.id === leased.deliveryId);
    const card = delivery ? view.cards.find((item) => item.id === delivery.cardId) : undefined;
    if (!delivery || !card) return { delivery: null };
    return { delivery: { id: delivery.id, cardId: delivery.cardId, channel: delivery.channel, card } };
  }

  delivered(cardId: string, channel: string, externalId?: string, now = this.now()) {
    return this.commit({ type: "delivered", cardId, channel, externalId }, now);
  }

  failedDelivery(cardId: string, channel: string, error: string, now = this.now()) {
    return this.commit({ type: "failed", cardId, channel, error }, now);
  }

  answer(cardId: string, body: { choice?: string; text?: string; responder?: string }, now = this.now()) {
    const { facts, view } = this.commit({ type: "answer", cardId, ...body }, now);
    const queued = [...facts].reverse().find((fact) => fact.type === "run.queued");
    return { facts, view, resumedRunId: queued && queued.type === "run.queued" ? queued.run.id : undefined };
  }

  resolve(cardId: string, summary?: string, now = this.now()) {
    return this.commit({ type: "resolve", cardId, summary }, now);
  }

  pause(ruleName: string, now = this.now()) {
    return this.commit({ type: "pause", ruleName }, now);
  }

  resume(ruleName: string, now = this.now()) {
    return this.commit({ type: "resume", ruleName }, now);
  }

  runRule(ruleName: string, payload?: unknown, now = this.now()) {
    const { facts, view } = this.commit({ type: "manual", ruleName, payload }, now);
    const queued = facts.find((fact) => fact.type === "run.queued");
    return { facts, view, runId: queued && queued.type === "run.queued" ? queued.run.id : undefined };
  }

  tick(now = this.now()) {
    return this.commit({ type: "tick" }, now);
  }

  fireDueCron(now = this.now()): Fact[] {
    const facts: Fact[] = [];
    const zoneDefault = this.config.hub.timezone || "Asia/Shanghai";
    for (const rule of this.view.rules) {
      if (rule.trigger.type !== "cron" || !rule.trigger.cron) continue;
      if (!rule.enabled || rule.paused || this.view.pauses[rule.name] !== undefined) continue;
      const zone = rule.trigger.timezone || zoneDefault;
      const last = this.lastCronEventAt(rule.name);
      const after = last ?? now - 1;
      const due = nextCronAt(rule.trigger.cron, after, zone);
      if (due === undefined || due > now) continue;
      // Avoid firing twice for the same scheduled instant.
      if (last !== undefined && last >= due) continue;
      const result = this.commit({ type: "cron", ruleName: rule.name, payload: { scheduledAt: due } }, now);
      facts.push(...result.facts);
    }
    return facts;
  }

  private lastCronEventAt(ruleName: string): number | undefined {
    const events = this.view.events.filter((event) => event.source === "cron" && event.ruleName === ruleName);
    if (!events.length) return undefined;
    return Math.max(...events.map((event) => event.createdAt));
  }

  nextDueAt(now = this.now()): number | undefined {
    let next: number | undefined;
    const consider = (at: number | undefined) => {
      if (at === undefined) return;
      if (next === undefined || at < next) next = at;
    };
    for (const timer of this.view.timers) {
      if (!timer.fired) consider(timer.fireAt);
    }
    const zoneDefault = this.config.hub.timezone || "Asia/Shanghai";
    for (const rule of this.view.rules) {
      if (rule.trigger.type !== "cron" || !rule.trigger.cron) continue;
      if (!rule.enabled || rule.paused || this.view.pauses[rule.name] !== undefined) continue;
      const zone = rule.trigger.timezone || zoneDefault;
      const last = this.lastCronEventAt(rule.name);
      consider(nextCronAt(rule.trigger.cron, last ?? now, zone));
    }
    this.nextCronDue = next;
    return next;
  }

  setConfig(config: AppConfig): AppConfig {
    const result = validateAppConfig(config);
    if (!result.ok) throw new DecisionError("invalid", result.error);
    this.config = result.value;
    if (!this.memory) saveConfig(this.dataDir, this.config);
    this.notifyConfig();
    return this.config;
  }

  setRules(data: unknown, now = this.now()): Rule[] {
    const result = validateRules(data);
    if (!result.ok) throw new DecisionError("invalid", result.error);
    if (!this.memory) saveRules(this.dataDir, result.value);
    this.rulesError = undefined;
    this.commit({ type: "rules", rules: result.value }, now);
    this.armSchedulers();
    return this.view.rules;
  }

  updateSecrets(body: { set?: Record<string, string>; unset?: string[] }): SecretKeyInfo[] {
    const next = { ...this.secrets };
    if (body.set) {
      for (const [name, value] of Object.entries(body.set)) {
        if (!name || typeof value !== "string") throw new DecisionError("invalid", "secret values must be strings");
        next[name] = value;
      }
    }
    if (body.unset) {
      for (const name of body.unset) delete next[name];
    }
    this.secrets = next;
    if (!this.memory) saveSecrets(this.dataDir, this.secrets);
    this.notifyConfig();
    return secretList(this.secrets);
  }

  listSecrets(): SecretKeyInfo[] {
    return secretList(this.secrets);
  }

  hasAuthKey(token: string): boolean {
    const envKeys = [process.env.AUTOLOOP_AUTH_KEY, process.env.AUTOLOOP_OWNER_KEY].filter(
      (value): value is string => Boolean(value),
    );
    if (envKeys.includes(token)) return true;
    const hash = hashKey(token);
    const row = this.db.prepare("SELECT name FROM keys WHERE hash = ?").get(hash);
    return Boolean(row);
  }

  addAuthKey(name: string, token?: string, now = this.now()): string {
    const value = token ?? randomBytes(32).toString("base64url");
    this.db.prepare("INSERT OR REPLACE INTO keys(name, hash, created_at) VALUES (?,?,?)").run(name, hashKey(value), now);
    return value;
  }

  touchWorker(name: string, capacity: number, running: string[], now = this.now()): void {
    this.workers.set(name, { name, capacity, running: running.slice(), lastSeenAt: now });
  }

  getState(): HubState {
    const runs = this.view.runs.slice();
    const cards = this.view.cards.slice();
    const active = new Set(["queued", "claimed", "running"]);
    return {
      config: this.config,
      rules: this.view.rules.slice(),
      runs,
      cards,
      workers: [...this.workers.values()],
      stats: {
        totalRuns: runs.length,
        activeRuns: runs.filter((run) => active.has(run.status)).length,
        openCards: cards.filter((card) => card.status === "open").length,
        totalEvents: this.view.events.length,
      },
    };
  }

  listRuns(query: { rule?: string; status?: string; limit?: number }): RunRecord[] {
    let runs = this.view.runs.slice().sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    if (query.rule) runs = runs.filter((run) => run.ruleName === query.rule);
    if (query.status) runs = runs.filter((run) => run.status === query.status);
    if (query.limit !== undefined) runs = runs.slice(0, query.limit);
    return runs;
  }

  listCards(status: string | undefined): Card[] {
    let cards = this.view.cards.slice().sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    if (status && status !== "all") cards = cards.filter((card) => card.status === status);
    return cards;
  }

  private armSchedulers(): void {
    if (!this.schedulersOn || this.closed) return;
    this.clearTimers();
    const now = this.now();
    const due = this.nextDueAt(now);
    if (due === undefined) return;
    const delay = Math.max(0, Math.min(due - now, 2_147_483_647));
    this.cronTimer = setTimeout(() => this.onSchedulerFire(), delay);
    this.cronTimer.unref();
  }

  private onSchedulerFire(): void {
    if (this.closed) return;
    try {
      const now = this.now();
      this.fireDueCron(now);
      this.tick(now);
    } catch (error) {
      console.error(error);
    }
    this.armSchedulers();
  }

  private clearTimers(): void {
    if (this.cronTimer) clearTimeout(this.cronTimer);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.cronTimer = undefined;
    this.tickTimer = undefined;
  }

  start(): void {
    if (this.schedulersOn) return;
    this.schedulersOn = true;
    this.closed = false;
    this.onSchedulerFire();
  }

  close(): void {
    this.closed = true;
    this.schedulersOn = false;
    this.clearTimers();
    this.listeners.clear();
    this.configListeners.clear();
    this.db.close();
  }
}

export function findRule(runtime: Runtime, name: string): Rule | undefined {
  return ruleByName(runtime.view.rules, name);
}
