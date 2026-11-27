export interface Rule {
  name: string;
  enabled: boolean;
  description?: string;
  trigger: {
    type: "cron" | "webhook" | "manual" | "event";
    cron?: string;
    timezone?: string;
    source?: string;
    eventType?: string;
  };
  agent: {
    adapter: "claude" | "codex" | "cursor" | "command" | "doubao";
    cwd: string;
    access: "plan" | "acceptEdits" | "bypassPermissions";
    prompt: string;
    command?: string[];
    timeoutMinutes?: number;
    model?: string;
  };
  channels: string[];
  laneKey?: string;
  paused?: boolean;
}

export interface AppConfig {
  hub: {
    host: string;
    port: number;
    publicUrl?: string;
    timezone: string;
  };
  worker: {
    enabled: boolean;
    name: string;
    capacity: number;
    pollTimeoutMs: number;
  };
  agents: {
    claude?: { enabled: boolean; bin?: string; defaultAccess?: string };
    codex?: { enabled: boolean; bin?: string };
    cursor?: { enabled: boolean; bin?: string };
    command?: { enabled: boolean };
    doubao?: { enabled: boolean; baseUrl?: string; model?: string; apiKeySecret?: string };
  };
  channels: {
    web: { enabled: boolean };
    desktop: { enabled: boolean };
    feishu?: {
      enabled: boolean;
      webhookUrlSecret?: string;
      appId?: string;
      appSecretKey?: string;
    };
    webhook?: {
      enabled: boolean;
      preset?: "dingtalk" | "wecom" | "slack" | "discord" | "custom";
      urlSecret?: string;
    };
  };
  sources: {
    github?: { enabled: boolean; webhookSecretKey?: string };
    gitlab?: { enabled: boolean; webhookSecretKey?: string };
  };
}

export interface Receipt {
  ask?: { title: string; body: string; options?: string[] };
  notice?: { title: string; body: string };
  resolve?: { cardId: string; summary?: string };
  later?: { delaySeconds: number; reason: string };
  events?: Array<{ type: string; lane?: string; payload: Record<string, unknown> }>;
}

export interface Job {
  runId: string;
  attempt: number;
  runToken: string;
  rule: Rule;
  lane: string;
  sessionId?: string;
  context: {
    events: Array<{
      id: string;
      type: string;
      source: string;
      payload: unknown;
      createdAt: number;
    }>;
    answer?: { cardId: string; choice?: string; text?: string; answeredAt: number };
    openCards: Array<{ id: string; title: string; body: string }>;
  };
}

export interface Card {
  id: string;
  runId: string;
  ruleName: string;
  lane: string;
  kind: "ask" | "notice";
  status: "open" | "decided" | "done" | "closed";
  title: string;
  body: string;
  options?: string[];
  answer?: { choice?: string; text?: string; responder?: string; answeredAt: number };
  createdAt: number;
  updatedAt: number;
}

export interface AgentCommandSpec {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentParsedOutput {
  finalText: string;
  sessionId?: string;
  usage?: Record<string, number>;
}

export interface AgentAdapter {
  name: string;
  buildCommand(
    job: Job,
    prompt: string,
    contextPath: string,
  ): AgentCommandSpec;
  parseOutput(stdout: string, stderr: string): AgentParsedOutput;
}

export type AccessMode = Rule["agent"]["access"];
export type AgentName = Rule["agent"]["adapter"];
