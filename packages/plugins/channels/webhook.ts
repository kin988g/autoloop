import type { AppConfig, Card, ChannelAdapter, ChannelSendResult } from "./types.ts";
import { buildCardUrl } from "./types.ts";

export type WebhookPreset = "dingtalk" | "wecom" | "slack" | "discord" | "custom";

export interface WebhookChannelOptions {
  fetchFn?: typeof fetch;
}

export function renderWebhookTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (Object.hasOwn(vars, key)) {
      return vars[key] ?? "";
    }
    return match;
  });
}

function kindLabel(kind: Card["kind"]): string {
  return kind === "ask" ? "需拍板" : "通知";
}

function cardTitle(card: Card): string {
  return `[${kindLabel(card.kind)}] ${card.title}`;
}

function optionsMarkdown(card: Card): string {
  if (!card.options || card.options.length === 0) return "";
  return card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
}

function markdownBody(card: Card, cardUrl: string): string {
  const parts = [
    `## ${cardTitle(card)}`,
    card.body,
    `规则: ${card.ruleName}  ·  车道: ${card.lane}`,
  ];
  const options = optionsMarkdown(card);
  if (options) parts.push(options);
  parts.push(`[打开卡片](${cardUrl})`);
  return parts.filter((part) => part.length > 0).join("\n\n");
}

export function buildWebhookPayload(
  preset: WebhookPreset,
  card: Card,
  config: AppConfig,
): Record<string, unknown> {
  const cardUrl = buildCardUrl(card, config);
  const title = cardTitle(card);
  const text = markdownBody(card, cardUrl);
  const color = card.kind === "ask" ? 0xe67e22 : 0x3498db;

  if (preset === "dingtalk") {
    return {
      msgtype: "markdown",
      markdown: { title, text },
    };
  }

  if (preset === "wecom") {
    return {
      msgtype: "markdown",
      markdown: { content: text },
    };
  }

  if (preset === "slack") {
    const blocks: Record<string, unknown>[] = [
      {
        type: "header",
        text: { type: "plain_text", text: title, emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: card.body || " " },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `规则: *${card.ruleName}*  ·  车道: *${card.lane}*`,
          },
        ],
      },
    ];
    if (card.options && card.options.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: optionsMarkdown(card) },
      });
    }
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "打开卡片", emoji: true },
          url: cardUrl,
        },
      ],
    });
    return { text, blocks };
  }

  if (preset === "discord") {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "规则", value: card.ruleName, inline: true },
      { name: "车道", value: card.lane, inline: true },
    ];
    if (card.options && card.options.length > 0) {
      fields.push({ name: "选项", value: optionsMarkdown(card) });
    }
    return {
      content: title,
      embeds: [
        {
          title: card.title,
          description: card.body,
          color,
          fields,
          url: cardUrl,
        },
      ],
    };
  }

  return {
    event: "card.created",
    card,
    cardUrl,
  };
}

function lookupWebhookUrl(config: AppConfig, secrets: Record<string, string>): string | undefined {
  const secretName = config.channels.webhook?.urlSecret ?? "";
  return (secretName ? secrets[secretName] : undefined) || secrets.WEBHOOK_URL;
}

export function createWebhookChannel(opts: WebhookChannelOptions = {}): ChannelAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "webhook",
    async sendCard(
      card: Card,
      config: AppConfig,
      secrets: Record<string, string>,
    ): Promise<ChannelSendResult> {
      if (!config.channels.webhook?.enabled) {
        return { ok: false, error: "Webhook channel is disabled" };
      }
      const url = lookupWebhookUrl(config, secrets);
      if (!url) {
        return { ok: false, error: "Webhook URL is not configured" };
      }
      const preset = config.channels.webhook.preset ?? "custom";
      const payload = buildWebhookPayload(preset, card, config);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const bearer = secrets.GROK_BOT_WEBHOOK_KEY || secrets.WEBHOOK_BEARER_TOKEN;
      if (bearer) {
        headers.authorization = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`;
      }
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            error: `Webhook HTTP ${response.status}: ${text || response.statusText}`,
          };
        }
        let externalId = `webhook:${card.id}`;
        if (text) {
          try {
            const json: unknown = JSON.parse(text);
            if (
              typeof json === "object" &&
              json !== null &&
              "id" in json &&
              typeof (json as { id: unknown }).id === "string"
            ) {
              externalId = `webhook:${(json as { id: string }).id}`;
            }
          } catch {
            // ignore non-JSON success bodies
          }
        }
        return { ok: true, externalId };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export const webhookChannel = createWebhookChannel();
