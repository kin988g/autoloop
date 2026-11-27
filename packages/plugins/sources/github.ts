import { createHmac, timingSafeEqual } from "node:crypto";
import type { SourceAdapter, SourceEvent, SourceVerifyResult } from "./types.ts";
import { getHeader, isRecord, parseJsonObject } from "./types.ts";

function verifyGitHubSignature(
  rawBody: string,
  secret: string,
  header: string,
): boolean {
  if (!header.toLowerCase().startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(hex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

function extractLane(payload: Record<string, unknown>): string | undefined {
  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  const fullName =
    repository && typeof repository.full_name === "string"
      ? repository.full_name
      : undefined;
  if (!fullName) return undefined;

  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const pullRequest = isRecord(payload.pull_request)
    ? payload.pull_request
    : undefined;
  const numberCandidate =
    (issue && typeof issue.number === "number" ? issue.number : undefined) ??
    (pullRequest && typeof pullRequest.number === "number"
      ? pullRequest.number
      : undefined) ??
    (typeof payload.number === "number" && (issue || pullRequest)
      ? payload.number
      : undefined);
  if (typeof numberCandidate === "number") {
    return `${fullName}#${numberCandidate}`;
  }

  if (typeof payload.ref === "string" && payload.ref.length > 0) {
    return `${fullName}:${shortRef(payload.ref)}`;
  }

  return fullName;
}

export const githubSource: SourceAdapter = {
  name: "github",
  verifyAndParse(
    headers: Record<string, string>,
    rawBody: string,
    secret?: string,
  ): SourceVerifyResult {
    if (secret) {
      const signature = getHeader(headers, "x-hub-signature-256");
      if (!signature) {
        return {
          ok: false,
          status: 401,
          error: "Missing X-Hub-Signature-256 header",
        };
      }
      if (!verifyGitHubSignature(rawBody, secret, signature)) {
        return {
          ok: false,
          status: 401,
          error: "Invalid GitHub webhook signature",
        };
      }
    }

    const parsed = parseJsonObject(rawBody);
    if (!parsed.ok) {
      return { ok: false, status: 400, error: parsed.error };
    }

    const event = getHeader(headers, "x-github-event");
    if (!event) {
      return {
        ok: false,
        status: 400,
        error: "Missing X-GitHub-Event header",
      };
    }

    const payload = parsed.value;
    const action = payload.action;
    const type =
      typeof action === "string" && action.length > 0
        ? `${event}.${action}`
        : event;
    const delivery = getHeader(headers, "x-github-delivery");
    const sourceEvent: SourceEvent = {
      type,
      payload,
    };
    const lane = extractLane(payload);
    if (lane) sourceEvent.lane = lane;
    if (delivery) sourceEvent.dedupeKey = `github:${delivery}`;
    return { ok: true, events: [sourceEvent] };
  },
};
