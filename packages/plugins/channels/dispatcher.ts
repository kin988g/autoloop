import { desktopChannel } from "./desktop.ts";
import { feishuChannel } from "./feishu.ts";
import type {
  AppConfig,
  Card,
  ChannelAdapter,
  ChannelSendResult,
} from "./types.ts";
import { webhookChannel } from "./webhook.ts";

export interface CardDelivery {
  id: string;
  cardId: string;
  channel: string;
  card: Card;
}

export type DispatchPollResult =
  | { status: "empty" }
  | { status: "delivered"; delivery: CardDelivery; externalId?: string }
  | { status: "failed"; delivery?: CardDelivery; error: string };

export interface ChannelDispatcherOptions {
  baseUrl: string;
  config: AppConfig;
  secrets?: Record<string, string>;
  fetchFn?: typeof fetch;
  token?: string;
  waitMs?: number;
  retryMs?: number;
  adapters?: Record<string, ChannelAdapter> | ChannelAdapter[];
  channels?: string[];
  onError?: (err: unknown, context?: { channel?: string; cardId?: string }) => void;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function adapterMap(
  adapters?: Record<string, ChannelAdapter> | ChannelAdapter[],
): Record<string, ChannelAdapter> {
  const builtin: Record<string, ChannelAdapter> = {
    desktop: desktopChannel,
    feishu: feishuChannel,
    webhook: webhookChannel,
  };
  if (!adapters) return { ...builtin };
  if (Array.isArray(adapters)) {
    const mapped: Record<string, ChannelAdapter> = { ...builtin };
    for (const adapter of adapters) {
      mapped[adapter.name] = adapter;
    }
    return mapped;
  }
  return { ...builtin, ...adapters };
}

function authHeaders(token?: string, json = false): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (json) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDelivery(payload: unknown): CardDelivery | null | "invalid" {
  if (!isRecord(payload)) return "invalid";
  if (payload.delivery === null || payload.delivery === undefined) {
    return payload.card ? "invalid" : null;
  }
  if (!isRecord(payload.delivery)) return "invalid";
  const delivery = payload.delivery;
  const id = typeof delivery.id === "string" ? delivery.id : undefined;
  const cardId = typeof delivery.cardId === "string" ? delivery.cardId : undefined;
  const channel = typeof delivery.channel === "string" ? delivery.channel : undefined;
  const card = delivery.card;
  if (!id || !cardId || !channel || !isRecord(card) || typeof card.id !== "string") {
    return "invalid";
  }
  return {
    id,
    cardId,
    channel,
    card: card as unknown as Card,
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export class ChannelDispatcher {
  #baseUrl: string;
  #config: AppConfig;
  #secrets: Record<string, string>;
  #fetchFn: typeof fetch;
  #token?: string;
  #waitMs: number;
  #retryMs: number;
  #adapters: Record<string, ChannelAdapter>;
  #channels: string[];
  #onError?: (err: unknown, context?: { channel?: string; cardId?: string }) => void;
  #abort: AbortController | undefined;
  #loops: Promise<void>[] = [];

  constructor(options: ChannelDispatcherOptions) {
    this.#baseUrl = trimBase(options.baseUrl);
    this.#config = options.config;
    this.#secrets = options.secrets ?? {};
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#token = options.token;
    this.#waitMs = options.waitMs ?? 30_000;
    this.#retryMs = options.retryMs ?? 1_000;
    this.#adapters = adapterMap(options.adapters);
    this.#channels = options.channels ?? Object.keys(this.#adapters);
    this.#onError = options.onError;
  }

  get running(): boolean {
    return this.#abort !== undefined;
  }

  start(): void {
    if (this.#abort) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loops = this.#channels.map((channel) => this.#loop(channel, abort.signal));
  }

  stop(): void {
    if (!this.#abort) return;
    this.#abort.abort();
    this.#abort = undefined;
    this.#loops = [];
  }

  async pollOnce(channel: string, signal?: AbortSignal): Promise<DispatchPollResult> {
    const url = `${this.#baseUrl}/v1/cards/next?channel=${encodeURIComponent(channel)}&wait=${this.#waitMs}`;
    let response: Response;
    try {
      response = await this.#fetchFn(url, {
        method: "GET",
        headers: authHeaders(this.#token),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return { status: "empty" };
      const error = err instanceof Error ? err.message : String(err);
      this.#onError?.(err, { channel });
      return { status: "failed", error };
    }

    const raw = await readBody(response);
    if (!response.ok) {
      const error = `GET /v1/cards/next HTTP ${response.status}: ${raw || response.statusText}`;
      this.#onError?.(new Error(error), { channel });
      return { status: "failed", error };
    }

    let payload: unknown = { delivery: null };
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        const error = "Invalid JSON from /v1/cards/next";
        this.#onError?.(new Error(error), { channel });
        return { status: "failed", error };
      }
    }

    const delivery = parseDelivery(payload);
    if (delivery === null) return { status: "empty" };
    if (delivery === "invalid") {
      const error = "Malformed delivery from /v1/cards/next";
      this.#onError?.(new Error(error), { channel });
      return { status: "failed", error };
    }

    const adapter = this.#adapters[delivery.channel] ?? this.#adapters[channel];
    if (!adapter) {
      const error = `No channel adapter registered for "${delivery.channel}"`;
      await this.#ackFailed(delivery, error, signal);
      return { status: "failed", delivery, error };
    }

    let result: ChannelSendResult;
    try {
      result = await adapter.sendCard(delivery.card, this.#config, this.#secrets);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#onError?.(err, { channel: delivery.channel, cardId: delivery.cardId });
      await this.#ackFailed(delivery, error, signal);
      return { status: "failed", delivery, error };
    }

    if (!result.ok) {
      const error = result.error ?? "Channel adapter failed";
      await this.#ackFailed(delivery, error, signal);
      return { status: "failed", delivery, error };
    }

    await this.#ackDelivered(delivery, result.externalId, signal);
    return { status: "delivered", delivery, externalId: result.externalId };
  }

  async #ackDelivered(
    delivery: CardDelivery,
    externalId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const body: { channel: string; externalId?: string } = { channel: delivery.channel };
    if (externalId) body.externalId = externalId;
    await this.#postAck(`/v1/cards/${encodeURIComponent(delivery.cardId)}/delivered`, body, delivery, signal);
  }

  async #ackFailed(
    delivery: CardDelivery,
    error: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#postAck(
      `/v1/cards/${encodeURIComponent(delivery.cardId)}/failed`,
      { channel: delivery.channel, error },
      delivery,
      signal,
    );
  }

  async #postAck(
    path: string,
    body: Record<string, unknown>,
    delivery: CardDelivery,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const response = await this.#fetchFn(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: authHeaders(this.#token, true),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const text = await readBody(response);
        this.#onError?.(
          new Error(`POST ${path} HTTP ${response.status}: ${text || response.statusText}`),
          { channel: delivery.channel, cardId: delivery.cardId },
        );
      }
    } catch (err) {
      if (signal?.aborted) return;
      this.#onError?.(err, { channel: delivery.channel, cardId: delivery.cardId });
    }
  }

  async #loop(channel: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.pollOnce(channel, signal);
        if (result.status === "failed") {
          await this.#sleep(this.#retryMs, signal);
        }
      } catch (err) {
        if (signal.aborted) return;
        this.#onError?.(err, { channel });
        await this.#sleep(this.#retryMs, signal);
      }
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
