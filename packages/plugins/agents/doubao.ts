import { fileURLToPath } from "node:url";
import { numericFields, parseJsonDocuments } from "./claude.ts";
import type { AccessMode, AgentAdapter, AgentParsedOutput, Job } from "./types.ts";

export const DEFAULT_DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_DOUBAO_MODEL = "doubao-seed-1-6-250615";
export const DEFAULT_DOUBAO_API_KEY_SECRET = "ARK_API_KEY";

export interface DoubaoAdapterConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeySecret?: string;
}

export function resolveDoubaoRunnerPath(metaUrl = import.meta.url): string {
  return fileURLToPath(new URL("./doubao-runner.mjs", metaUrl));
}

export function resolveDoubaoApiKey(
  config?: DoubaoAdapterConfig,
  secrets?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const direct = config?.apiKey?.trim();
  if (direct) return direct;
  const secretName = config?.apiKeySecret?.trim() || DEFAULT_DOUBAO_API_KEY_SECRET;
  const fromSecret = secrets?.[secretName]?.trim();
  if (fromSecret) return fromSecret;
  const fromEnv = env.ARK_API_KEY?.trim() || env.DOUBAO_API_KEY?.trim();
  return fromEnv || undefined;
}

function accessOf(job: Job): AccessMode {
  return job.rule.agent.access ?? "acceptEdits";
}

function resolveModel(job: Job, config?: DoubaoAdapterConfig, env: NodeJS.ProcessEnv = process.env): string {
  return (
    job.rule.agent.model?.trim() ||
    config?.model?.trim() ||
    env.ARK_MODEL?.trim() ||
    DEFAULT_DOUBAO_MODEL
  );
}

function resolveBaseUrl(config?: DoubaoAdapterConfig, env: NodeJS.ProcessEnv = process.env): string {
  return (config?.baseUrl?.trim() || env.ARK_BASE_URL?.trim() || DEFAULT_DOUBAO_BASE_URL).replace(/\/+$/, "");
}

function parseDoubaoDocuments(documents: unknown[]): AgentParsedOutput | undefined {
  for (let i = documents.length - 1; i >= 0; i -= 1) {
    const document = documents[i];
    if (typeof document !== "object" || document === null || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    if (typeof record.finalText !== "string") continue;
    const usage = numericFields(record.usage);
    return { finalText: record.finalText, ...(usage ? { usage } : {}) };
  }
  return undefined;
}

export function createDoubaoAdapter(config?: DoubaoAdapterConfig): AgentAdapter {
  return {
    name: "doubao",
    buildCommand(job: Job, prompt: string, contextPath: string) {
      const env: Record<string, string> = {
        AUTOLOOP_CONTEXT_PATH: contextPath,
        AUTOLOOP_RUN_ID: job.runId,
        AUTOLOOP_LANE: job.lane,
        AUTOLOOP_RULE_NAME: job.rule.name,
        AUTOLOOP_ACCESS: accessOf(job),
        AUTOLOOP_PROMPT: prompt,
        ARK_BASE_URL: resolveBaseUrl(config),
        ARK_MODEL: resolveModel(job, config),
      };
      const apiKey = resolveDoubaoApiKey(config);
      if (apiKey) env.ARK_API_KEY = apiKey;
      return {
        bin: process.execPath,
        args: [resolveDoubaoRunnerPath()],
        env,
      };
    },
    parseOutput(stdout: string, _stderr: string): AgentParsedOutput {
      const parsed = parseDoubaoDocuments(parseJsonDocuments(stdout));
      if (parsed) return parsed;
      return { finalText: stdout.trim() };
    },
  };
}

export const doubaoAdapter = createDoubaoAdapter();
