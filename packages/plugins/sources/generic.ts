import { createHmac, timingSafeEqual } from "node:crypto";
import type { SourceAdapter, SourceEvent, SourceVerifyResult } from "./types.ts";
import {
  getHeader,
  isRecord,
  parseJsonObject,
  timingSafeStringEqual,
} from "./types.ts";

function normalizeSignature(value: string): string {
  return value.trim().replace(/^sha256=/i, "").trim();
}

function verifyHmacSha256(rawBody: string, secret: string, signature: string): boolean {
  const hex = normalizeSignature(signature);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(hex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function bearerToken(headers: Record<string, string>): string | undefined {
  const authorization = getHeader(headers, "authorization");
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(\S+)/i);
  return match?.[1];
}

function authorized(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
): boolean {
  const hmacSig =
    getHeader(headers, "x-webhook-signature") ??
    getHeader(headers, "x-signature-256");
  if (hmacSig && verifyHmacSha256(rawBody, secret, hmacSig)) {
    return true;
  }
  const token = getHeader(headers, "x-webhook-token") ?? bearerToken(headers);
  if (token && timingSafeStringEqual(token, secret)) {
    return true;
  }
  return false;
}

function eventFromItem(
  item: Record<string, unknown>,
  headers: Record<string, string>,
): SourceEvent {
  const headerType = getHeader(headers, "x-event-type");
  const type =
    (typeof item.type === "string" && item.type) ||
    (typeof item.event === "string" && item.event) ||
    (headerType && headerType) ||
    "webhook.received";
  const event: SourceEvent = {
    type,
    payload: isRecord(item.payload) ? item.payload : item,
  };
  if (typeof item.lane === "string" && item.lane.length > 0) {
    event.lane = item.lane;
  }
  const headerDedupe =
    getHeader(headers, "x-idempotency-key") ??
    getHeader(headers, "x-delivery-id");
  if (typeof item.dedupeKey === "string" && item.dedupeKey.length > 0) {
    event.dedupeKey = item.dedupeKey;
  } else if (headerDedupe) {
    event.dedupeKey = headerDedupe;
  }
  return event;
}

export function createWebhookSource(name = "custom"): SourceAdapter {
  return {
    name,
    verifyAndParse(
      headers: Record<string, string>,
      rawBody: string,
      secret?: string,
    ): SourceVerifyResult {
      if (secret && !authorized(headers, rawBody, secret)) {
        return {
          ok: false,
          status: 401,
          error: "Invalid or missing webhook signature or token",
        };
      }

      const parsed = parseJsonObject(rawBody);
      if (!parsed.ok) {
        return { ok: false, status: 400, error: parsed.error };
      }

      const body = parsed.value;
      if ("events" in body) {
        if (!Array.isArray(body.events)) {
          return { ok: false, status: 400, error: "events must be an array" };
        }
        const events: SourceEvent[] = [];
        for (const item of body.events) {
          if (!isRecord(item)) {
            return {
              ok: false,
              status: 400,
              error: "each event must be an object",
            };
          }
          events.push(eventFromItem(item, headers));
        }
        return { ok: true, events };
      }

      return { ok: true, events: [eventFromItem(body, headers)] };
    },
  };
}

export const createGenericSource = createWebhookSource;
export const webhookSource = createWebhookSource("custom");
export const genericSource = createWebhookSource("generic");
