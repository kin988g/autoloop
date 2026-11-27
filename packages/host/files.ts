import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { defaultAppConfig, validateAppConfig, validateRules } from "../protocol/validate.ts";
import type { AppConfig, Rule, SecretKeyInfo } from "../protocol/types.ts";

export const CONFIG_FILE = "config.json";
export const RULES_FILE = "rules.json";
export const SECRETS_FILE = "secrets.env";
export const DB_FILE = "hub.db";

export function resolveDataDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AUTOLOOP_DATA_DIR) return process.env.AUTOLOOP_DATA_DIR;
  return join(homedir(), ".autoloop-studio");
}

export function ensureDir(dir: string): void {
  if (dir === ":memory:") return;
  mkdirSync(dir, { recursive: true });
}

export function writeAtomic(file: string, contents: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode });
  renameSync(tmp, file);
}

export function loadConfig(dataDir: string): AppConfig {
  const file = join(dataDir, CONFIG_FILE);
  if (!existsSync(file)) return defaultAppConfig();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const result = validateAppConfig(parsed);
    return result.ok ? result.value : defaultAppConfig();
  } catch {
    return defaultAppConfig();
  }
}

export function saveConfig(dataDir: string, config: AppConfig): void {
  writeAtomic(join(dataDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function loadRules(dataDir: string): { rules: Rule[]; error?: string } {
  const file = join(dataDir, RULES_FILE);
  if (!existsSync(file)) return { rules: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const result = validateRules(parsed);
    if (!result.ok) return { rules: [], error: result.error };
    return { rules: result.value };
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function saveRules(dataDir: string, rules: Rule[]): void {
  writeAtomic(join(dataDir, RULES_FILE), `${JSON.stringify({ rules }, null, 2)}\n`);
}

export function parseSecretsEnv(text: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name) secrets[name] = value;
  }
  return secrets;
}

export function formatSecretsEnv(secrets: Record<string, string>): string {
  const lines = Object.keys(secrets)
    .sort()
    .map((name) => {
      const value = secrets[name];
      const escaped = /[\n\r#]/.test(value) || value.includes(" ") || value.includes("=") ? JSON.stringify(value) : value;
      return `${name}=${escaped}`;
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function loadSecrets(dataDir: string): Record<string, string> {
  const file = join(dataDir, SECRETS_FILE);
  if (!existsSync(file)) return {};
  try {
    return parseSecretsEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveSecrets(dataDir: string, secrets: Record<string, string>): void {
  writeAtomic(join(dataDir, SECRETS_FILE), formatSecretsEnv(secrets), 0o600);
}

export function secretList(secrets: Record<string, string>): SecretKeyInfo[] {
  return Object.keys(secrets)
    .sort()
    .map((name) => ({ name, configured: secrets[name] !== undefined && secrets[name] !== "" }));
}
