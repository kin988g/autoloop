import type { SourceAdapter, SourceEvent, SourceVerifyResult } from "./types.ts";
import {
  getHeader,
  isRecord,
  parseJsonObject,
  timingSafeStringEqual,
} from "./types.ts";

function normalizeGitlabEventHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+hook$/, "")
    .replace(/\s+/g, "_");
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

function eventType(
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): string {
  const kind =
    typeof payload.object_kind === "string" && payload.object_kind.length > 0
      ? payload.object_kind
      : undefined;
  const attrs = isRecord(payload.object_attributes)
    ? payload.object_attributes
    : undefined;
  const action =
    attrs && typeof attrs.action === "string" && attrs.action.length > 0
      ? attrs.action
      : undefined;
  if (kind && action) return `${kind}.${action}`;
  if (kind) return kind;
  const header = getHeader(headers, "x-gitlab-event");
  if (header) return normalizeGitlabEventHeader(header);
  return "gitlab";
}

function extractLane(payload: Record<string, unknown>): string | undefined {
  const project = isRecord(payload.project) ? payload.project : undefined;
  const path =
    (project && typeof project.path_with_namespace === "string"
      ? project.path_with_namespace
      : undefined) ??
    (typeof payload.path_with_namespace === "string"
      ? payload.path_with_namespace
      : undefined);
  if (!path) return undefined;

  const kind =
    typeof payload.object_kind === "string" ? payload.object_kind : "";
  const attrs = isRecord(payload.object_attributes)
    ? payload.object_attributes
    : undefined;
  const iid =
    attrs && (typeof attrs.iid === "number" || typeof attrs.iid === "string")
      ? String(attrs.iid)
      : undefined;

  if ((kind === "issue" || kind === "confidential_issue") && iid) {
    return `${path}#${iid}`;
  }
  if ((kind === "merge_request" || kind === "confidential_merge_request") && iid) {
    return `${path}!${iid}`;
  }
  if (kind === "push" || kind === "tag_push") {
    const ref = typeof payload.ref === "string" ? payload.ref : undefined;
    if (ref) return `${path}:${shortRef(ref)}`;
  }
  return path;
}

function uuidFromHeaders(headers: Record<string, string>): string | undefined {
  return (
    getHeader(headers, "x-gitlab-event-uuid") ??
    getHeader(headers, "x-gitlab-webhook-uuid")
  );
}

export const gitlabSource: SourceAdapter = {
  name: "gitlab",
  verifyAndParse(
    headers: Record<string, string>,
    rawBody: string,
    secret?: string,
  ): SourceVerifyResult {
    if (secret) {
      const token = getHeader(headers, "x-gitlab-token");
      if (!token || !timingSafeStringEqual(token, secret)) {
        return {
          ok: false,
          status: 401,
          error: "Invalid or missing X-Gitlab-Token header",
        };
      }
    }

    const parsed = parseJsonObject(rawBody);
    if (!parsed.ok) {
      return { ok: false, status: 400, error: parsed.error };
    }

    const payload = parsed.value;
    const sourceEvent: SourceEvent = {
      type: eventType(payload, headers),
      payload,
    };
    const lane = extractLane(payload);
    if (lane) sourceEvent.lane = lane;
    const uuid = uuidFromHeaders(headers);
    if (uuid) sourceEvent.dedupeKey = `gitlab:${uuid}`;
    return { ok: true, events: [sourceEvent] };
  },
};
