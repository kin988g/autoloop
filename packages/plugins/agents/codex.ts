import { numericFields, parseJsonDocuments } from "./claude.ts";
import type { AgentAdapter, AgentParsedOutput, Job } from "./types.ts";

const DEFAULT_BIN = "codex";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sandboxArgs(access: Job["rule"]["agent"]["access"]): string[] {
  if (access === "plan") return ["--sandbox", "read-only"];
  if (access === "acceptEdits") return ["--sandbox", "workspace-write"];
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

function itemText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content) {
      if (typeof part === "string") parts.push(part);
      else if (asRecord(part) && typeof asRecord(part)!.text === "string") {
        parts.push(asRecord(part)!.text as string);
      }
    }
    if (parts.length) return parts.join("");
  }
  return undefined;
}

function parseCodexDocuments(documents: unknown[]): AgentParsedOutput | undefined {
  if (documents.length === 0) return undefined;
  let finalText: string | undefined;
  let sessionId: string | undefined;
  let usage: Record<string, number> | undefined;
  let sawObject = false;

  for (const document of documents) {
    const record = asRecord(document);
    if (!record) continue;
    sawObject = true;
    const type = record.type;
    if (type === "thread.started") {
      if (typeof record.thread_id === "string" && record.thread_id) sessionId = record.thread_id;
      else if (typeof record.threadId === "string" && record.threadId) sessionId = record.threadId;
    } else if (type === "item.completed") {
      const item = asRecord(record.item);
      const text = itemText(item);
      if (
        text !== undefined &&
        (!item?.type || item.type === "agent_message" || item.type === "agent-message")
      ) {
        finalText = text;
      }
    } else if (type === "turn.completed") {
      const foundUsage = numericFields(record.usage);
      if (foundUsage) usage = foundUsage;
    }

    if (typeof record.session_id === "string" && record.session_id) sessionId = record.session_id;
    if (typeof record.sessionId === "string" && record.sessionId) sessionId = record.sessionId;
    if (typeof record.result === "string") finalText = record.result;
    if (typeof record.finalText === "string") finalText = record.finalText;
    const topUsage = numericFields(record.usage);
    if (topUsage && type !== "item.completed") usage = topUsage;
  }

  if (!sawObject) return undefined;
  return { finalText: finalText ?? "", ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) };
}

export function createCodexAdapter(config?: { bin?: string }): AgentAdapter {
  const bin = config?.bin || DEFAULT_BIN;

  return {
    name: "codex",
    buildCommand(job: Job, prompt: string, contextPath: string) {
      const args = ["exec"];
      if (job.sessionId) args.push("resume", job.sessionId);
      args.push(...sandboxArgs(job.rule.agent.access), "--json", prompt);
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
      const parsed = parseCodexDocuments(parseJsonDocuments(stdout));
      if (parsed) return parsed;
      return { finalText: stdout.trim() };
    },
  };
}

export const codexAdapter = createCodexAdapter();
