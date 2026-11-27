import type { AppConfig, Card, Job, Receipt, Rule, RunOutcome, SecretKeyInfo } from "./types.ts";

export type HubClientOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
};

type Query = Record<string, string | number | boolean | undefined>;

export class HubClient {
  readonly baseUrl: string;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3350").replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private url(path: string, query?: Query): string {
    const target = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) target.searchParams.set(key, String(value));
      }
    }
    return target.toString();
  }

  async request<T>(method: string, path: string, options: { query?: Query; body?: unknown; raw?: boolean } = {}): Promise<T> {
    const headers = this.headers(options.body !== undefined ? { "Content-Type": "application/json" } : undefined);
    const response = await this.fetchImpl(this.url(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text || response.statusText;
      throw new HubError(response.status, message, data);
    }
    return data as T;
  }

  healthz() {
    return this.request<{ ok: true; version: string; uptimeMs: number }>("GET", "/healthz");
  }

  postEvent(body: { type: string; source: string; lane?: string; payload?: unknown; dedupeKey?: string; hops?: number }) {
    return this.request<{ eventId: string; runId?: string; queued: boolean; circuitBroken?: boolean }>("POST", "/v1/events", {
      body,
    });
  }

  ingest(source: string, body: unknown, headers: Record<string, string> = {}) {
    const encoded = encodeURIComponent(source);
    return this.fetchImpl(this.url(`/v1/in/${encoded}`), {
      method: "POST",
      headers: this.headers({ "Content-Type": headers["content-type"] ?? "application/json", ...headers }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new HubError(response.status, data?.error ?? response.statusText, data);
      return data as { eventIds: string[]; queued: boolean };
    });
  }

  getWork(query: { worker?: string; capacity?: number; running?: string | string[]; wait?: number } = {}) {
    const running = Array.isArray(query.running) ? query.running.join(",") : query.running;
    return this.request<{ job: Job | null }>("GET", "/v1/work", {
      query: { worker: query.worker, capacity: query.capacity, running, wait: query.wait },
    });
  }

  started(runId: string, body: { runToken?: string } = {}) {
    return this.request<{ ok: true }>("POST", `/v1/runs/${encodeURIComponent(runId)}/started`, { body });
  }

  result(
    runId: string,
    body: {
      outcome: RunOutcome;
      sessionId?: string;
      receipt?: Receipt;
      error?: string;
      usage?: Record<string, number>;
      runToken?: string;
    },
  ) {
    return this.request<{ ok: true; cardId?: string }>("POST", `/v1/runs/${encodeURIComponent(runId)}/result`, { body });
  }

  cancel(runId: string) {
    return this.request<{ ok: true }>("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
  }

  listRuns(query: { rule?: string; status?: string; limit?: number } = {}) {
    return this.request<{ runs: unknown[] }>("GET", "/v1/runs", { query });
  }

  listCards(query: { status?: "open" | "decided" | "done" | "closed" | "all" } = {}) {
    return this.request<{ cards: Card[] }>("GET", "/v1/cards", { query });
  }

  nextCard(query: { channel?: string; wait?: number } = {}) {
    return this.request<{ delivery: { id: string; cardId: string; channel: string; card: Card } | null }>(
      "GET",
      "/v1/cards/next",
      { query },
    );
  }

  delivered(cardId: string, body: { channel: string; externalId?: string }) {
    return this.request<{ ok: true }>("POST", `/v1/cards/${encodeURIComponent(cardId)}/delivered`, { body });
  }

  failed(cardId: string, body: { channel: string; error: string }) {
    return this.request<{ ok: true }>("POST", `/v1/cards/${encodeURIComponent(cardId)}/failed`, { body });
  }

  answer(cardId: string, body: { choice?: string; text?: string; responder?: string }) {
    return this.request<{ ok: true; resumedRunId?: string }>("POST", `/v1/cards/${encodeURIComponent(cardId)}/answer`, {
      body,
    });
  }

  resolve(cardId: string, body: { summary?: string } = {}) {
    return this.request<{ ok: true }>("POST", `/v1/cards/${encodeURIComponent(cardId)}/resolve`, { body });
  }

  state() {
    return this.request<{
      config: AppConfig;
      rules: Rule[];
      runs: unknown[];
      cards: Card[];
      workers: unknown[];
      stats: { totalRuns: number; activeRuns: number; openCards: number; totalEvents: number };
    }>("GET", "/v1/state");
  }

  getConfig() {
    return this.request<{ config: AppConfig }>("GET", "/v1/config");
  }

  putConfig(config: AppConfig) {
    return this.request<{ ok: true; config: AppConfig }>("PUT", "/v1/config", { body: config });
  }

  getRules() {
    return this.request<{ rules: Rule[]; error?: string }>("GET", "/v1/rules");
  }

  putRules(rules: Rule[] | { rules: Rule[] }) {
    const body = Array.isArray(rules) ? { rules } : rules;
    return this.request<{ ok: true; rules: Rule[] }>("PUT", "/v1/rules", { body });
  }

  pauseRule(name: string) {
    return this.request<{ ok: true; runId?: string }>("POST", `/v1/rules/${encodeURIComponent(name)}/pause`, { body: {} });
  }

  resumeRule(name: string) {
    return this.request<{ ok: true; runId?: string }>("POST", `/v1/rules/${encodeURIComponent(name)}/resume`, { body: {} });
  }

  runRule(name: string, body: Record<string, unknown> = {}) {
    return this.request<{ ok: true; runId?: string }>("POST", `/v1/rules/${encodeURIComponent(name)}/run`, { body });
  }

  getSecrets() {
    return this.request<{ keys: SecretKeyInfo[] }>("GET", "/v1/secrets");
  }

  putSecrets(body: { set?: Record<string, string>; unset?: string[] }) {
    return this.request<{ ok: true; keys: SecretKeyInfo[] }>("PUT", "/v1/secrets", { body });
  }

  async stream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetchImpl(this.url("/v1/stream"), {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => response.statusText);
      throw new HubError(response.status, text, text);
    }
    return response.body;
  }
}

export class HubError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.data = data;
  }
}

export function createHubClient(options?: HubClientOptions): HubClient {
  return new HubClient(options);
}
