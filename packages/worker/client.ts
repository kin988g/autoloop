import type { Job } from "../plugins/agents/types.ts";
import type { RunResultPayload } from "./contract.ts";

export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HubError";
  }
}

export interface PollWorkOptions {
  worker: string;
  capacity: number;
  running: string[];
  waitMs: number;
  signal?: AbortSignal;
}

export interface HubClientOptions {
  baseUrl: string;
  authToken?: string;
  fetch?: typeof fetch;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export class HubClient {
  #baseUrl: string;
  #authToken?: string;
  #fetch: typeof fetch;

  constructor(options: HubClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#authToken = options.authToken;
    this.#fetch = options.fetch ?? fetch;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async pollWork(options: PollWorkOptions): Promise<Job | null> {
    const query = new URLSearchParams({
      worker: options.worker,
      capacity: String(options.capacity),
      running: options.running.join(","),
      wait: String(options.waitMs),
    });
    const timeoutMs = Math.max(options.waitMs, 0) + 10_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const data = await this.#call("GET", `/v1/work?${query}`, {
      token: this.#authToken,
      signal,
    });
    if (!data || typeof data !== "object") return null;
    const job = (data as { job?: Job | null }).job;
    return job ?? null;
  }

  reportStarted(runId: string, runToken: string): Promise<{ ok: true }> {
    return this.#call("POST", `/v1/runs/${encodeURIComponent(runId)}/started`, {
      token: runToken || this.#authToken,
      body: {},
    }) as Promise<{ ok: true }>;
  }

  reportResult(
    runId: string,
    runToken: string,
    result: RunResultPayload,
    signal?: AbortSignal,
  ): Promise<{ ok: true; cardId?: string }> {
    return this.#call("POST", `/v1/runs/${encodeURIComponent(runId)}/result`, {
      token: runToken || this.#authToken,
      body: { ...result, runToken },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }) as Promise<{ ok: true; cardId?: string }>;
  }

  async #call(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.#fetch(joinUrl(this.#baseUrl, path), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Hub returned ${response.status}`;
      throw new HubError(response.status, message);
    }
    return data;
  }
}
