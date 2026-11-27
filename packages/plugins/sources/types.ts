import { timingSafeEqual } from "node:crypto";

export interface SourceEvent {
  type: string;
  lane?: string;
  dedupeKey?: string;
  payload: Record<string, unknown>;
}

export type SourceVerifyResult =
  | { ok: true; events: SourceEvent[] }
  | { ok: false; status: number; error: string };

export interface SourceAdapter {
  name: string;
  verifyAndParse(
    headers: Record<string, string>,
    rawBody: string,
    secret?: string,
  ): SourceVerifyResult;
}

export interface CronRuleLike {
  name: string;
  enabled: boolean;
  paused?: boolean;
  trigger: {
    type: string;
    cron?: string;
    timezone?: string;
  };
}

export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(
  rawBody: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(rawBody);
    if (!isRecord(value)) {
      return { ok: false, error: "JSON body must be an object" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
