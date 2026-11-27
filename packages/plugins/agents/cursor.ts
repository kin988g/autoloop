import { existsSync } from "node:fs";
import path from "node:path";
import { numericFields, parseJsonDocuments } from "./claude.ts";
import type { AccessMode, AgentAdapter, AgentParsedOutput, Job } from "./types.ts";

const DEFAULT_BIN = "agent";

export interface CursorBinResolveOptions {
  bin?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
}

/**
 * Resolve the Cursor Agent CLI binary.
 * An explicit `bin` is used as-is. Otherwise, on Windows, prefer
 * `%LOCALAPPDATA%\cursor-agent\agent.cmd`, then `agent.ps1`, then `agent`.
 */
export function resolveCursorAgentBin(options: CursorBinResolveOptions = {}): string {
  const configured = options.bin?.trim();
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const env = options.env ?? process.env;
    const exists = options.exists ?? existsSync;
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      const pathImpl = path.win32;
      const cmd = pathImpl.join(localAppData, "cursor-agent", "agent.cmd");
      if (exists(cmd)) return cmd;
      const ps1 = pathImpl.join(localAppData, "cursor-agent", "agent.ps1");
      if (exists(ps1)) return ps1;
    }
  }
  return DEFAULT_BIN;
}

function accessOf(job: Job): AccessMode {
  return job.rule.agent.access ?? "acceptEdits";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readSessionId(record: Record<string, unknown>): string | undefined {
  for (const key of ["session_id", "sessionId"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function parseCursorDocuments(documents: unknown[]): AgentParsedOutput | undefined {
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

function accessArgs(access: AccessMode): string[] {
  if (access === "plan") return ["--mode", "plan"];
  if (access === "bypassPermissions") return ["--force"];
  return [];
}

export function createCursorAdapter(config?: CursorBinResolveOptions): AgentAdapter {
  return {
    name: "cursor",
    buildCommand(job: Job, prompt: string, contextPath: string) {
      const bin = resolveCursorAgentBin(config);
      const args = ["-p", "--output-format", "json", "--trust", ...accessArgs(accessOf(job))];
      if (job.sessionId) args.push("--resume", job.sessionId);
      const model = job.rule.agent.model?.trim();
      if (model) args.push("--model", model);
      args.push(prompt);
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
      const parsed = parseCursorDocuments(parseJsonDocuments(stdout));
      if (parsed) return parsed;
      return { finalText: stdout.trim() };
    },
  };
}

export const cursorAdapter = createCursorAdapter();
