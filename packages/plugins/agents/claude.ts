import type { AccessMode, AgentAdapter, AgentParsedOutput, Job, Rule } from "./types.ts";

const DEFAULT_BIN = "claude";

function accessOf(job: Job, defaultAccess?: AccessMode): AccessMode {
  return job.rule.agent.access ?? defaultAccess ?? "plan";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function numericFields(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, field] of Object.entries(record)) {
    if (typeof field === "number" && Number.isFinite(field)) usage[key] = field;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function parseJsonDocuments(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) ? value : [value];
  } catch {
    // Fall through to newline-delimited JSON.
  }
  const documents: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim();
    if (!row) continue;
    try {
      const value = JSON.parse(row);
      if (Array.isArray(value)) documents.push(...value);
      else documents.push(value);
    } catch {
      // Ignore non-JSON lines mixed into the stream.
    }
  }
  return documents;
}

function readSessionId(record: Record<string, unknown>): string | undefined {
  for (const key of ["session_id", "sessionId"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function parseClaudeDocuments(documents: unknown[]): AgentParsedOutput | undefined {
  if (documents.length === 0) return undefined;
  let finalText: string | undefined;
  let sessionId: string | undefined;
  let usage: Record<string, number> | undefined;
  let sawObject = false;

  for (const document of documents) {
    const record = asRecord(document);
    if (!record) continue;
    sawObject = true;
    const foundSession = readSessionId(record);
    if (foundSession) sessionId = foundSession;
    const foundUsage = numericFields(record.usage);
    if (foundUsage) usage = foundUsage;
    if (record.type === "result" || typeof record.result === "string") {
      if (typeof record.result === "string") finalText = record.result;
    }
    if (typeof record.finalText === "string") finalText = record.finalText;
  }

  if (!sawObject) return undefined;
  return { finalText: finalText ?? "", ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) };
}

export function createClaudeAdapter(config?: {
  bin?: string;
  defaultAccess?: Rule["agent"]["access"];
}): AgentAdapter {
  const bin = config?.bin || DEFAULT_BIN;
  const defaultAccess = config?.defaultAccess;

  return {
    name: "claude",
    buildCommand(job: Job, prompt: string, contextPath: string) {
      const access = accessOf(job, defaultAccess);
      const args = ["-p", prompt, "--output-format", "json", "--permission-mode", access];
      if (job.sessionId) args.push("--resume", job.sessionId);
      return {
        bin,
        args,
        env: {
          AUTOLOOP_CONTEXT_PATH: contextPath,
          AUTOLOOP_RUN_ID: job.runId,
          AUTOLOOP_LANE: job.lane,
          AUTOLOOP_RULE_NAME: job.rule.name,
        },
      };
    },
    parseOutput(stdout: string, _stderr: string): AgentParsedOutput {
      const parsed = parseClaudeDocuments(parseJsonDocuments(stdout));
      if (parsed) return parsed;
      return { finalText: stdout.trim() };
    },
  };
}

export const claudeAdapter = createClaudeAdapter();
