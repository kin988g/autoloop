import { numericFields } from "./claude.ts";
import type { AgentAdapter, AgentParsedOutput, Job } from "./types.ts";

const PLACEHOLDER = /\{(prompt|contextPath|runId|lane|sessionId)\}/g;

function substitute(part: string, values: Record<string, string>): string {
  return part.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? "");
}

function parseCommandJson(stdout: string): AgentParsedOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (typeof value.finalText !== "string") return undefined;
    const sessionId =
      typeof value.sessionId === "string"
        ? value.sessionId
        : typeof value.session_id === "string"
          ? value.session_id
          : undefined;
    const usage = numericFields(value.usage);
    return {
      finalText: value.finalText,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createCommandAdapter(): AgentAdapter {
  return {
    name: "command",
    buildCommand(job: Job, prompt: string, contextPath: string) {
      const command = job.rule.agent.command;
      if (!command || command.length === 0 || !command[0]) {
        throw new Error("command adapter requires rule.agent.command to be a non-empty array");
      }
      const values = {
        prompt,
        contextPath,
        runId: job.runId,
        lane: job.lane,
        sessionId: job.sessionId ?? "",
      };
      const env: Record<string, string> = {
        AUTOLOOP_CONTEXT_PATH: contextPath,
        AUTOLOOP_RUN_ID: job.runId,
        AUTOLOOP_LANE: job.lane,
        AUTOLOOP_RULE_NAME: job.rule.name,
        AUTOLOOP_PROMPT: prompt,
      };
      if (job.sessionId) env.AUTOLOOP_SESSION_ID = job.sessionId;
      return {
        bin: command[0],
        args: command.slice(1).map((part) => substitute(part, values)),
        env,
      };
    },
    parseOutput(stdout: string, _stderr: string): AgentParsedOutput {
      return parseCommandJson(stdout) ?? { finalText: stdout.trim() };
    },
  };
}

export const commandAdapter = createCommandAdapter();
