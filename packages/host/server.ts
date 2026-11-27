import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getSourceAdapter as lookupPluginSource } from "../plugins/sources/index.ts";
import { validateAppConfig, validateReceipt, validateRules } from "../protocol/validate.ts";
import { DecisionError } from "../kernel/decide.ts";
import type { Fact } from "../protocol/types.ts";
import { Runtime, type RuntimeOptions } from "./runtime.ts";
import { defaultWebDist, isApiPath, tryServeStatic } from "./static.ts";

export type SourceParseResult =
  | { ok: true; events: Array<{ type: string; lane?: string; dedupeKey?: string; payload: Record<string, unknown> }> }
  | { ok: false; status: number; error: string };

export type SourceAdapter = {
  name: string;
  verifyAndParse(
    headers: Record<string, string>,
    rawBody: string,
    secret?: string,
  ): SourceParseResult | Promise<SourceParseResult>;
};

const sourceAdapters = new Map<string, SourceAdapter>();

export function registerSourceAdapter(adapter: SourceAdapter): void {
  sourceAdapters.set(adapter.name, adapter);
}

export function getSourceAdapter(name: string): SourceAdapter | undefined {
  return sourceAdapters.get(name);
}

function asSourceAdapter(value: unknown): SourceAdapter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as { name?: unknown; verifyAndParse?: unknown };
  if (typeof rec.name === "string" && typeof rec.verifyAndParse === "function") {
    return value as SourceAdapter;
  }
  return undefined;
}

async function loadSourceAdapter(name: string): Promise<SourceAdapter | undefined> {
  const registered = sourceAdapters.get(name) ?? sourceAdapters.get(name.toLowerCase());
  if (registered) return registered;
  const plugin = lookupPluginSource(name);
  if (plugin) {
    sourceAdapters.set(name, plugin);
    sourceAdapters.set(plugin.name, plugin);
    return plugin;
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return undefined;
  const candidates = [
    new URL(`../plugins/sources/${name}.ts`, import.meta.url).href,
    new URL(`../plugins/sources/${name}/index.ts`, import.meta.url).href,
  ];
  for (const url of candidates) {
    try {
      const mod = (await import(url)) as Record<string, unknown>;
      const adapter =
        asSourceAdapter(mod.default) ??
        asSourceAdapter(mod.adapter) ??
        Object.values(mod)
          .map(asSourceAdapter)
          .find((item): item is SourceAdapter => Boolean(item));
      if (adapter) {
        sourceAdapters.set(name, adapter);
        sourceAdapters.set(adapter.name, adapter);
        return adapter;
      }
    } catch {
      // Adapter is optional; callers fall back to JSON parsing.
    }
  }
  return undefined;
}

export function resolveSourceSecret(runtime: Runtime, source: string): string | undefined {
  const sources = runtime.config.sources as Record<string, { webhookSecretKey?: string } | undefined>;
  const entry = sources[source] ?? sources[source.toLowerCase()];
  const configured = entry?.webhookSecretKey;
  const candidates = [
    configured,
    `${source.toUpperCase().replace(/-/g, "_")}_SECRET`,
    `${source.toUpperCase().replace(/-/g, "_")}_WEBHOOK_SECRET`,
    source,
    source.toLowerCase(),
  ];
  for (const key of candidates) {
    if (key && runtime.secrets[key]) return runtime.secrets[key];
  }
  return undefined;
}

function fallbackParse(rawBody: string): SourceParseResult {
  try {
    const data = JSON.parse(rawBody);
    if (Array.isArray(data)) {
      return {
        ok: true,
        events: data.map((item) => normalizeIncoming(item)),
      };
    }
    if (data && typeof data === "object") {
      if (Array.isArray((data as { events?: unknown }).events)) {
        return {
          ok: true,
          events: ((data as { events: unknown[] }).events).map((item) => normalizeIncoming(item)),
        };
      }
      return { ok: true, events: [normalizeIncoming(data)] };
    }
    return { ok: false, status: 400, error: "invalid webhook body" };
  } catch {
    return { ok: false, status: 400, error: "invalid json" };
  }
}

function normalizeIncoming(item: unknown): { type: string; lane?: string; dedupeKey?: string; payload: Record<string, unknown> } {
  const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : { value: item };
  const type = typeof rec.type === "string" && rec.type ? rec.type : "webhook";
  const event: { type: string; lane?: string; dedupeKey?: string; payload: Record<string, unknown> } = {
    type,
    payload: rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)
      ? (rec.payload as Record<string, unknown>)
      : rec,
  };
  if (typeof rec.lane === "string") event.lane = rec.lane;
  if (typeof rec.dedupeKey === "string") event.dedupeKey = rec.dedupeKey;
  return event;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function setCors(res: ServerResponse): void {
  for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === ":ffff:127.0.0.1" || addr === "::ffff:127.0.0.1";
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  setCors(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function errorStatus(error: unknown): { status: number; error: string } {
  if (error instanceof DecisionError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    return { status, error: error.message };
  }
  return { status: 500, error: error instanceof Error ? error.message : String(error) };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function queryOf(url: URL): URLSearchParams {
  return url.searchParams;
}

type Waiter = { done: (wake: boolean) => void };

export type HubServerOptions = RuntimeOptions & {
  host?: string;
  port?: number;
  runtime?: Runtime;
  /** Directory of the built web console (`apps/web/dist`). `false` disables static hosting. */
  staticDir?: string | false;
};

export class HubServer {
  readonly runtime: Runtime;
  readonly host: string;
  readonly startedAt: number;
  readonly staticDir: string | undefined;
  private server: Server;
  private listening = false;
  private closed = false;
  private waiters = new Set<Waiter>();
  private streams = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private unlisten: () => void;
  private readonly ownsRuntime: boolean;

  constructor(options: HubServerOptions = {}) {
    this.runtime = options.runtime ?? new Runtime(options);
    this.ownsRuntime = !options.runtime;
    this.host = options.host ?? this.runtime.config.hub.host ?? "127.0.0.1";
    this.startedAt = Date.now();
    this.staticDir = options.staticDir === false ? undefined : options.staticDir ?? defaultWebDist();
    this.unlisten = this.runtime.onChange((facts) => this.broadcast(facts));
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get port(): number {
    const addr = this.server.address();
    if (addr && typeof addr === "object") return (addr as AddressInfo).port;
    return 0;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  private authorized(req: IncomingMessage, pathname = req.url ?? "/"): boolean {
    const token = bearer(req);
    const requireAuth = process.env.AUTOLOOP_REQUIRE_AUTH === "1";
    if (token && this.runtime.hasAuthKey(token)) return true;
    if (token && this.isRunScopedToken(pathname, token)) return true;
    if (token) return false;
    if (requireAuth) return false;
    return isLoopback(req);
  }

  /** Workers authenticate started/result/cancel with the claim's runToken as Bearer. */
  private isRunScopedToken(pathname: string, token: string): boolean {
    const path = pathname.split("?")[0] ?? pathname;
    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "runs" || !parts[2]) return false;
    const action = parts[3];
    if (action !== "started" && action !== "result" && action !== "cancel") return false;
    const runId = decodeURIComponent(parts[2]);
    const run = this.runtime.view.runs.find((item) => item.id === runId);
    return Boolean(run?.runToken && run.runToken === token);
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter.done(true);
  }

  private broadcast(facts: Fact[]): void {
    this.wake();
    for (const fact of facts) this.pushSse({ type: fact.type, at: fact.at });
  }

  private pushSse(data: { type: string; at: number }): void {
    const payload = `event: update\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.streams) {
      try {
        res.write(payload);
      } catch {
        this.streams.delete(res);
      }
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), ms);
      const waiter: Waiter = {
        done: (wake: boolean) => finish(wake),
      };
      const finish = (wake: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal.removeEventListener("abort", onAbort);
        resolve(wake);
      };
      const onAbort = () => finish(false);
      this.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) finish(false);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      setCors(res);
      const method = (req.method ?? "GET").toUpperCase();
      if (method === "OPTIONS") {
        res.writeHead(204, { ...CORS, "Content-Length": "0" });
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (
        (method === "GET" || method === "HEAD") &&
        this.staticDir &&
        !isApiPath(url.pathname) &&
        tryServeStatic(this.staticDir, url.pathname, method, res)
      ) {
        return;
      }
      if (!this.authorized(req, url.pathname)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (method === "GET" && url.pathname === "/healthz") {
        send(res, 200, { ok: true, version: "0.1.0", uptimeMs: Date.now() - this.startedAt });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/stream") {
        this.handleStream(req, res);
        return;
      }
      const bodyText = method === "GET" || method === "HEAD" ? "" : await readBody(req);
      await this.route(method, parts, url, bodyText, req, res);
    } catch (error) {
      if (error instanceof SyntaxError) {
        send(res, 400, { error: "invalid json" });
        return;
      }
      const mapped = errorStatus(error);
      send(res, mapped.status, { error: mapped.error });
    }
  }

  private handleStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(":\n\n");
    this.streams.add(res);
    const close = () => {
      this.streams.delete(res);
      res.end();
    };
    req.on("close", () => this.streams.delete(res));
    req.on("aborted", () => this.streams.delete(res));
    if (this.closed) close();
  }

  private async route(
    method: string,
    parts: string[],
    url: URL,
    bodyText: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const q = queryOf(url);
    if (method === "POST" && url.pathname === "/v1/events") {
      const body = parseJson(bodyText) as Record<string, unknown>;
      if (typeof body.type !== "string" || typeof body.source !== "string") {
        send(res, 400, { error: "type and source are required" });
        return;
      }
      const result = this.runtime.ingest({
        type: body.type,
        source: body.source,
        lane: typeof body.lane === "string" ? body.lane : undefined,
        payload: body.payload,
        dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
        hops: typeof body.hops === "number" ? body.hops : undefined,
      });
      send(res, 200, {
        eventId: result.eventId,
        runId: result.runId,
        queued: result.queued,
        circuitBroken: result.circuitBroken,
      });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "in" && parts[2] && parts.length === 3) {
      const source = decodeURIComponent(parts[2]);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(",");
      }
      const adapter = (await loadSourceAdapter(source)) ?? {
        name: source,
        verifyAndParse: (_headers: Record<string, string>, raw: string) => fallbackParse(raw),
      };
      const secret = resolveSourceSecret(this.runtime, source);
      const parsed = await adapter.verifyAndParse(headers, bodyText, secret);
      if (!parsed.ok) {
        send(res, parsed.status, { error: parsed.error });
        return;
      }
      const eventIds: string[] = [];
      let queued = false;
      for (const event of parsed.events) {
        const result = this.runtime.ingest({
          type: event.type,
          source,
          lane: event.lane,
          payload: event.payload,
          dedupeKey: event.dedupeKey,
        });
        eventIds.push(result.eventId);
        queued = queued || result.queued;
      }
      send(res, 200, { eventIds, queued });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/work") {
      const worker = q.get("worker") || "worker";
      const capacity = Number(q.get("capacity") ?? 1);
      const running = (q.get("running") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const wait = Number(q.get("wait") ?? 0);
      const cap = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      let job = this.runtime.claim(worker, cap, running);
      const deadline = Date.now() + Math.max(0, wait);
      while (!job && wait > 0 && !this.closed && !ac.signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const woken = await this.wait(remaining, ac.signal);
        job = this.runtime.claim(worker, cap, running);
        if (!woken) break;
      }
      send(res, 200, { job });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "runs" && parts[3] === "started" && parts[2]) {
      const body = parseJson(bodyText) as { runToken?: string };
      this.runtime.started(decodeURIComponent(parts[2]), body.runToken);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "runs" && parts[3] === "result" && parts[2]) {
      const body = parseJson(bodyText) as Record<string, unknown>;
      const outcome = body.outcome;
      if (outcome !== "done" && outcome !== "nothing" && outcome !== "failed" && outcome !== "cancelled") {
        send(res, 400, { error: "outcome must be done, nothing, failed, or cancelled" });
        return;
      }
      let receipt = body.receipt;
      if (typeof receipt === "string") {
        const parsed = validateReceipt(JSON.parse(receipt));
        receipt = parsed.ok ? parsed.value : undefined;
      } else if (receipt !== undefined) {
        const parsed = validateReceipt(receipt);
        if (!parsed.ok) {
          send(res, 400, { error: parsed.error });
          return;
        }
        receipt = parsed.value;
      }
      const result = this.runtime.result(decodeURIComponent(parts[2]), {
        outcome,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        receipt: receipt as import("../protocol/types.ts").Receipt | undefined,
        error: typeof body.error === "string" ? body.error : undefined,
        usage: body.usage && typeof body.usage === "object" ? (body.usage as Record<string, number>) : undefined,
        runToken: typeof body.runToken === "string" ? body.runToken : undefined,
      });
      send(res, 200, { ok: true, cardId: result.cardId });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "runs" && parts[3] === "cancel" && parts[2]) {
      this.runtime.cancel(decodeURIComponent(parts[2]));
      send(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/runs") {
      const limitRaw = q.get("limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      send(res, 200, {
        runs: this.runtime.listRuns({
          rule: q.get("rule") ?? undefined,
          status: q.get("status") ?? undefined,
          limit: limit !== undefined && Number.isFinite(limit) ? Math.floor(limit) : undefined,
        }),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/cards/next") {
      const channel = q.get("channel") || "web";
      const wait = Number(q.get("wait") ?? 0);
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      let delivery = this.runtime.lease(channel).delivery;
      const deadline = Date.now() + Math.max(0, wait);
      while (!delivery && wait > 0 && !this.closed && !ac.signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const woken = await this.wait(remaining, ac.signal);
        delivery = this.runtime.lease(channel).delivery;
        if (!woken) break;
      }
      send(res, 200, { delivery });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/cards") {
      send(res, 200, { cards: this.runtime.listCards(q.get("status") ?? undefined) });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "cards" && parts[3] === "delivered" && parts[2]) {
      const body = parseJson(bodyText) as { channel?: string; externalId?: string };
      if (!body.channel) {
        send(res, 400, { error: "channel is required" });
        return;
      }
      this.runtime.delivered(decodeURIComponent(parts[2]), body.channel, body.externalId);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "cards" && parts[3] === "failed" && parts[2]) {
      const body = parseJson(bodyText) as { channel?: string; error?: string };
      if (!body.channel || typeof body.error !== "string") {
        send(res, 400, { error: "channel and error are required" });
        return;
      }
      this.runtime.failedDelivery(decodeURIComponent(parts[2]), body.channel, body.error);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "cards" && parts[3] === "answer" && parts[2]) {
      const body = parseJson(bodyText) as { choice?: string; text?: string; responder?: string };
      const result = this.runtime.answer(decodeURIComponent(parts[2]), body);
      send(res, 200, { ok: true, resumedRunId: result.resumedRunId });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "cards" && parts[3] === "resolve" && parts[2]) {
      const body = parseJson(bodyText) as { summary?: string };
      this.runtime.resolve(decodeURIComponent(parts[2]), body.summary);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/state") {
      send(res, 200, this.runtime.getState());
      return;
    }
    if (method === "GET" && url.pathname === "/v1/config") {
      send(res, 200, { config: this.runtime.config });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/config") {
      const body = parseJson(bodyText);
      const result = validateAppConfig(body);
      if (!result.ok) {
        send(res, 400, { error: result.error });
        return;
      }
      const config = this.runtime.setConfig(result.value);
      send(res, 200, { ok: true, config });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/rules") {
      send(res, 200, { rules: this.runtime.view.rules, error: this.runtime.rulesError });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/rules") {
      const body = parseJson(bodyText);
      const result = validateRules(body);
      if (!result.ok) {
        send(res, 400, { error: result.error });
        return;
      }
      const rules = this.runtime.setRules(result.value);
      send(res, 200, { ok: true, rules });
      return;
    }
    if (method === "POST" && parts[0] === "v1" && parts[1] === "rules" && parts[3] && parts[2]) {
      const name = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (action === "pause") {
        this.runtime.pause(name);
        send(res, 200, { ok: true });
        return;
      }
      if (action === "resume") {
        this.runtime.resume(name);
        send(res, 200, { ok: true });
        return;
      }
      if (action === "run") {
        const body = parseJson(bodyText) as Record<string, unknown>;
        const result = this.runtime.runRule(name, body);
        send(res, 200, { ok: true, runId: result.runId });
        return;
      }
    }
    if (method === "GET" && url.pathname === "/v1/secrets") {
      send(res, 200, { keys: this.runtime.listSecrets() });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/secrets") {
      const body = parseJson(bodyText) as { set?: Record<string, string>; unset?: string[] };
      const keys = this.runtime.updateSecrets(body ?? {});
      send(res, 200, { ok: true, keys });
      return;
    }
    send(res, 404, { error: "not found" });
  }

  listen(port?: number, host?: string): Promise<this> {
    const bindPort = port ?? this.runtime.config.hub.port ?? 3350;
    const bindHost = host ?? this.host;
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(bindPort, bindHost, () => {
        this.server.removeListener("error", reject);
        this.listening = true;
        this.runtime.start();
        this.heartbeat = setInterval(() => {
          for (const res of this.streams) {
            try {
              res.write(": ping\n\n");
            } catch {
              this.streams.delete(res);
            }
          }
        }, 15_000);
        this.heartbeat.unref();
        resolve(this);
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unlisten();
    for (const waiter of [...this.waiters]) waiter.done(false);
    for (const res of this.streams) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    this.streams.clear();
    return new Promise((resolve, reject) => {
      const finish = () => {
        try {
          this.runtime.close();
        } catch {
          // already closed
        }
        resolve();
      };
      if (!this.listening) {
        finish();
        return;
      }
      this.server.close((error) => (error ? reject(error) : finish()));
    });
  }
}

export async function startHub(options: HubServerOptions = {}): Promise<HubServer> {
  const server = new HubServer(options);
  await server.listen(options.port, options.host);
  return server;
}
