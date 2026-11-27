import { claudeAdapter, createClaudeAdapter } from "./claude.ts";
import { codexAdapter, createCodexAdapter } from "./codex.ts";
import { commandAdapter, createCommandAdapter } from "./command.ts";
import { cursorAdapter, createCursorAdapter } from "./cursor.ts";
import { createDoubaoAdapter, doubaoAdapter, resolveDoubaoApiKey } from "./doubao.ts";
import { extractReceipt, parseReceipt, validateReceipt } from "./receipt.ts";
import type { AccessMode, AgentAdapter, AppConfig } from "./types.ts";

export type {
  AccessMode,
  AgentAdapter,
  AgentCommandSpec,
  AgentName,
  AgentParsedOutput,
  AppConfig,
  Card,
  Job,
  Receipt,
  Rule,
} from "./types.ts";
export type { ReceiptExtract } from "./receipt.ts";
export {
  extractReceipt,
  parseReceipt,
  validateReceipt,
} from "./receipt.ts";
export { claudeAdapter, createClaudeAdapter } from "./claude.ts";
export { codexAdapter, createCodexAdapter } from "./codex.ts";
export { commandAdapter, createCommandAdapter } from "./command.ts";
export { cursorAdapter, createCursorAdapter, resolveCursorAgentBin } from "./cursor.ts";
export {
  createDoubaoAdapter,
  doubaoAdapter,
  resolveDoubaoApiKey,
  resolveDoubaoRunnerPath,
  DEFAULT_DOUBAO_API_KEY_SECRET,
  DEFAULT_DOUBAO_BASE_URL,
  DEFAULT_DOUBAO_MODEL,
} from "./doubao.ts";

const ACCESS_MODES = new Set<AccessMode>(["plan", "acceptEdits", "bypassPermissions"]);

function asAccess(value: string | undefined): AccessMode | undefined {
  if (value && ACCESS_MODES.has(value as AccessMode)) return value as AccessMode;
  return undefined;
}

export function createAgentRegistry(
  agentsConfig?: AppConfig["agents"],
  secrets?: Record<string, string>,
): Map<string, AgentAdapter> {
  const registry = new Map<string, AgentAdapter>();
  const claude = agentsConfig?.claude;
  if (!claude || claude.enabled !== false) {
    registry.set(
      "claude",
      createClaudeAdapter({
        bin: claude?.bin,
        defaultAccess: asAccess(claude?.defaultAccess),
      }),
    );
  }
  const codex = agentsConfig?.codex;
  if (!codex || codex.enabled !== false) {
    registry.set("codex", createCodexAdapter({ bin: codex?.bin }));
  }
  const cursor = agentsConfig?.cursor;
  if (!cursor || cursor.enabled !== false) {
    registry.set("cursor", createCursorAdapter({ bin: cursor?.bin }));
  }
  const command = agentsConfig?.command;
  if (!command || command.enabled !== false) {
    registry.set("command", createCommandAdapter());
  }
  const doubao = agentsConfig?.doubao;
  if (doubao?.enabled) {
    registry.set(
      "doubao",
      createDoubaoAdapter({
        baseUrl: doubao.baseUrl,
        model: doubao.model,
        apiKeySecret: doubao.apiKeySecret,
        apiKey: resolveDoubaoApiKey(doubao, secrets),
      }),
    );
  }
  return registry;
}

export function getAgentAdapter(
  name: string,
  agentsConfig?: AppConfig["agents"],
  secrets?: Record<string, string>,
): AgentAdapter {
  const registry = createAgentRegistry(agentsConfig, secrets);
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`Unknown or disabled agent adapter: ${name}`);
  }
  return adapter;
}

/** Default adapters used when no registry config is supplied. */
export const defaultAdapters = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  command: commandAdapter,
  doubao: doubaoAdapter,
};
