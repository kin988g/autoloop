import {
  type AnswerCardBody,
  type AnswerCardResult,
  type AppConfig,
  type CancelRunResult,
  type Card,
  type CardStatus,
  type Healthz,
  type HubState,
  type PostEventBody,
  type PostEventResult,
  type ResolveCardResult,
  type Rule,
  type RuleActionResult,
  type SecretKey,
  type SseUpdate,
  type PutSecretsBody,
  asBoolean,
  asOptionalString,
  asString,
  isRecord,
  parseAppConfig,
  parseCards,
  parseErrorMessage,
  parseHealth,
  parseHubState,
  parseRules,
  parseRuns,
  parseSecretKeys,
  parseSseUpdate,
  type RunRecord,
} from "./types";

export const STORAGE_BASE_URL = "autoloop.hub.baseUrl";
export const STORAGE_TOKEN = "autoloop.hub.token";

/** Empty string means same-origin (Vite dev proxy in dev, same host in production). */
export const DEFAULT_BASE_URL = "";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status = 0, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function getStoredBaseUrl(): string {
  try {
    const stored = localStorage.getItem(STORAGE_BASE_URL);
    return stored === null ? DEFAULT_BASE_URL : stored;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function getStoredToken(): string {
  try {
    return localStorage.getItem(STORAGE_TOKEN) ?? "";
  } catch {
    return "";
  }
}

export function persistConnection(baseUrl: string, token: string): void {
  try {
    localStorage.setItem(STORAGE_BASE_URL, baseUrl);
    if (token) localStorage.setItem(STORAGE_TOKEN, token);
    else localStorage.removeItem(STORAGE_TOKEN);
  } catch {
    // Ignore quota / private-mode failures; in-memory values still work for the session.
  }
}

export function apiUrl(path: string, baseUrl = getStoredBaseUrl()): string {
  const base = baseUrl.replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

function authHeaders(token = getStoredToken()): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & {
    parse: (raw: unknown) => T;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const { parse, baseUrl, token, timeoutMs = 20000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (rest.signal) {
    const parent = rest.signal;
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(apiUrl(path, baseUrl ?? getStoredBaseUrl()), {
      ...rest,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(token ?? getStoredToken()),
        ...(rest.headers ?? {}),
      },
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new ApiError(parseErrorMessage(body, `HTTP ${response.status}`), response.status, body);
    }
    return parse(body);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("请求超时或已取消", 0);
    }
    const message = error instanceof Error ? error.message : "网络不可用";
    throw new ApiError(message.includes("Failed to fetch") || message.includes("NetworkError") ? "无法连接 Hub" : message, 0);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  healthz: (opts?: { baseUrl?: string; token?: string; signal?: AbortSignal }) =>
    request("/healthz", {
      parse: parseHealth,
      baseUrl: opts?.baseUrl,
      token: opts?.token,
      signal: opts?.signal,
      timeoutMs: 8000,
    }),

  getState: (opts?: { signal?: AbortSignal }) =>
    request("/v1/state", { parse: parseHubState, signal: opts?.signal }),

  getRuns: (query?: { rule?: string; status?: string; limit?: number }, opts?: { signal?: AbortSignal }) => {
    const params = new URLSearchParams();
    if (query?.rule) params.set("rule", query.rule);
    if (query?.status) params.set("status", query.status);
    if (typeof query?.limit === "number") params.set("limit", String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request(`/v1/runs${suffix}`, {
      parse: (raw) => parseRuns(raw),
      signal: opts?.signal,
    });
  },

  cancelRun: (id: string) =>
    request(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      parse: (raw): CancelRunResult => ({ ok: isRecord(raw) ? asBoolean(raw.ok, true) : true }),
    }),

  getCards: (status: CardStatus | "all" = "all", opts?: { signal?: AbortSignal }) => {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return request(`/v1/cards${suffix}`, {
      parse: (raw) => parseCards(raw),
      signal: opts?.signal,
    });
  },

  answerCard: (id: string, body: AnswerCardBody) =>
    request(`/v1/cards/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
      parse: (raw): AnswerCardResult => {
        const rec = isRecord(raw) ? raw : {};
        return {
          ok: asBoolean(rec.ok, true),
          resumedRunId: asOptionalString(rec.resumedRunId),
        };
      },
    }),

  resolveCard: (id: string, summary?: string) =>
    request(`/v1/cards/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(summary ? { summary } : {}),
      parse: (raw): ResolveCardResult => ({ ok: isRecord(raw) ? asBoolean(raw.ok, true) : true }),
    }),

  getRules: (opts?: { signal?: AbortSignal }) =>
    request("/v1/rules", {
      parse: (raw) => ({
        rules: parseRules(raw),
        error: isRecord(raw) ? asOptionalString(raw.error) : undefined,
      }),
      signal: opts?.signal,
    }),

  putRules: (rules: Rule[]) =>
    request("/v1/rules", {
      method: "PUT",
      body: JSON.stringify({ rules }),
      parse: (raw) => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        rules: parseRules(raw),
      }),
    }),

  pauseRule: (name: string) =>
    request(`/v1/rules/${encodeURIComponent(name)}/pause`, {
      method: "POST",
      parse: (raw): RuleActionResult => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        runId: isRecord(raw) ? asOptionalString(raw.runId) : undefined,
      }),
    }),

  resumeRule: (name: string) =>
    request(`/v1/rules/${encodeURIComponent(name)}/resume`, {
      method: "POST",
      parse: (raw): RuleActionResult => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        runId: isRecord(raw) ? asOptionalString(raw.runId) : undefined,
      }),
    }),

  runRule: (name: string) =>
    request(`/v1/rules/${encodeURIComponent(name)}/run`, {
      method: "POST",
      parse: (raw): RuleActionResult => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        runId: isRecord(raw) ? asOptionalString(raw.runId) : undefined,
      }),
    }),

  getConfig: (opts?: { signal?: AbortSignal }) =>
    request("/v1/config", {
      parse: (raw) => parseAppConfig(isRecord(raw) && "config" in raw ? raw.config : raw),
      signal: opts?.signal,
    }),

  putConfig: (config: AppConfig) =>
    request("/v1/config", {
      method: "PUT",
      body: JSON.stringify(config),
      parse: (raw) => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        config: parseAppConfig(isRecord(raw) && "config" in raw ? raw.config : raw),
      }),
    }),

  getSecrets: (opts?: { signal?: AbortSignal }) =>
    request("/v1/secrets", {
      parse: (raw) => parseSecretKeys(raw),
      signal: opts?.signal,
    }),

  putSecrets: (body: PutSecretsBody) =>
    request("/v1/secrets", {
      method: "PUT",
      body: JSON.stringify(body),
      parse: (raw) => ({
        ok: isRecord(raw) ? asBoolean(raw.ok, true) : true,
        keys: parseSecretKeys(raw),
      }),
    }),

  postEvent: (body: PostEventBody) =>
    request("/v1/events", {
      method: "POST",
      body: JSON.stringify(body),
      parse: (raw): PostEventResult => {
        const rec = isRecord(raw) ? raw : {};
        return {
          eventId: asString(rec.eventId, ""),
          runId: asOptionalString(rec.runId),
          queued: asBoolean(rec.queued, false),
          circuitBroken: typeof rec.circuitBroken === "boolean" ? rec.circuitBroken : undefined,
        };
      },
    }),
};

export type LiveMode = "connecting" | "live" | "polling" | "offline";

export interface StreamOptions {
  baseUrl?: string;
  token?: string;
  onEvent: (event: SseUpdate) => void;
  onStatus: (mode: Exclude<LiveMode, "offline">) => void;
  onError?: (message: string) => void;
}

/**
 * SSE auto-refresh: EventSource when no token, fetch streaming reader when Bearer token is set.
 * Automatic reconnect with exponential backoff; caller should also run fallback polling.
 */
export function connectStream(options: StreamOptions): () => void {
  const baseUrl = options.baseUrl ?? getStoredBaseUrl();
  const token = (options.token ?? getStoredToken()).trim();
  const url = apiUrl("/v1/stream", baseUrl);
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let source: EventSource | undefined;

  const cleanupSocket = () => {
    if (source) {
      source.close();
      source = undefined;
    }
    if (abort) {
      abort.abort();
      abort = undefined;
    }
  };

  const handlePayload = (payload: string) => {
    const event = parseSseUpdate(payload);
    if (event) options.onEvent(event);
    else options.onEvent({ type: "update" });
  };

  const parseSseChunk = (chunk: string) => {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0 && !eventName) return;
    handlePayload(dataLines.join("\n") || JSON.stringify({ type: eventName || "update" }));
  };

  const schedule = () => {
    if (closed) return;
    const delay = Math.min(15000, 1000 * 2 ** retry);
    retry += 1;
    options.onStatus("connecting");
    timer = setTimeout(start, delay);
  };

  const startFetchStream = async () => {
    abort = new AbortController();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...authHeaders(token),
      },
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      throw new ApiError(parseErrorMessage(await readBody(response), `HTTP ${response.status}`), response.status);
    }
    retry = 0;
    options.onStatus("live");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) parseSseChunk(part.replace(/\r/g, ""));
      }
    }
    if (!closed) throw new ApiError("SSE 连接已断开", 0);
  };

  const startEventSource = () =>
    new Promise<void>((resolve, reject) => {
      const es = new EventSource(url);
      source = es;
      let opened = false;
      const onAny = (ev: Event) => {
        const message = ev as MessageEvent<string>;
        handlePayload(typeof message.data === "string" ? message.data : "");
      };
      es.addEventListener("open", () => {
        opened = true;
        retry = 0;
        options.onStatus("live");
      });
      es.addEventListener("update", onAny);
      es.onmessage = onAny;
      es.onerror = () => {
        es.close();
        if (source === es) source = undefined;
        if (!opened) reject(new ApiError("SSE 连接失败", 0));
        else resolve();
      };
    });

  const start = () => {
    if (closed) return;
    options.onStatus("connecting");
    const task = token ? startFetchStream() : startEventSource();
    void task
      .then(() => {
        if (!closed) schedule();
      })
      .catch((error: unknown) => {
        if (closed) return;
        const message = error instanceof Error ? error.message : "SSE 连接失败";
        options.onError?.(message);
        options.onStatus("polling");
        schedule();
      });
  };

  start();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    cleanupSocket();
  };
}

export type { Healthz, HubState, RunRecord, Card, SecretKey };
