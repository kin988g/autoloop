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
    command?: { enabled: boolean };
  };
  channels: {
    web: { enabled: boolean };
    desktop: { enabled: boolean };
    feishu?: { enabled: boolean; webhookUrlSecret?: string; appId?: string; appSecretKey?: string };
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

export interface ChannelSendResult {
  ok: boolean;
  externalId?: string;
  error?: string;
}

export interface ChannelAdapter {
  name: string;
  sendCard(
    card: Card,
    config: AppConfig,
    secrets: Record<string, string>,
  ): Promise<ChannelSendResult>;
}

export function buildCardUrl(card: Card, config: AppConfig): string {
  const base = config.hub.publicUrl
    ? config.hub.publicUrl.replace(/\/+$/, "")
    : `http://${config.hub.host}:${config.hub.port}`;
  return `${base}/#cards/${encodeURIComponent(card.id)}`;
}
