import type { AppConfig, Card, ChannelAdapter, ChannelSendResult } from "./types.ts";
import { buildCardUrl } from "./types.ts";

export interface FeishuChannelOptions {
  fetchFn?: typeof fetch;
}

export type FeishuCallbackResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "answer"; cardId: string; choice?: string; text?: string; responder?: string }
  | { kind: "error"; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildFeishuCardPayload(card: Card, config: AppConfig): Record<string, unknown> {
  const headerTitle = card.kind === "ask" ? `[需拍板] ${card.title}` : `[通知] ${card.title}`;
  const headerTemplate = card.kind === "ask" ? "orange" : "blue";
  const cardUrl = buildCardUrl(card, config);
  const elements: Record<string, unknown>[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: card.body || "" },
    },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `规则: ${card.ruleName}  ·  车道: ${card.lane}`,
        },
      ],
    },
  ];

  if (card.options && card.options.length > 0) {
    const list = card.options
      .map((option, index) => `${index + 1}. ${option}`)
      .join("\n");
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: list },
    });
  }

  const actions: Record<string, unknown>[] = [];
  if (card.options && card.options.length > 0) {
    for (const option of card.options) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: option },
        type: "default",
        value: { cardId: card.id, choice: option },
      });
    }
  }
  actions.push({
    tag: "button",
    text: { tag: "plain_text", content: "打开卡片" },
    type: "primary",
    url: cardUrl,
  });
  elements.push({ tag: "action", actions });

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: headerTitle },
        template: headerTemplate,
      },
      elements,
    },
  };
}

function lookupWebhookUrl(config: AppConfig, secrets: Record<string, string>): string | undefined {
  const secretName = config.channels.feishu?.webhookUrlSecret ?? "";
  return (secretName ? secrets[secretName] : undefined) || secrets.FEISHU_WEBHOOK_URL;
}

function pickExternalId(body: unknown, cardId: string): string {
  if (isRecord(body) && isRecord(body.data)) {
    const messageId = body.data.message_id ?? body.data.open_message_id ?? body.data.MessageId;
    if (typeof messageId === "string" && messageId.length > 0) {
      return `feishu:${messageId}`;
    }
  }
  return `feishu:${cardId}`;
}

export function createFeishuChannel(opts: FeishuChannelOptions = {}): ChannelAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "feishu",
    async sendCard(
      card: Card,
      config: AppConfig,
      secrets: Record<string, string>,
    ): Promise<ChannelSendResult> {
      if (!config.channels.feishu?.enabled) {
        return { ok: false, error: "Feishu channel is disabled" };
      }
      const url = lookupWebhookUrl(config, secrets);
      if (!url) {
        return { ok: false, error: "Feishu webhook URL is not configured" };
      }
      const payload = buildFeishuCardPayload(card, config);
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        let json: unknown;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
        }
        if (!response.ok) {
          return {
            ok: false,
            error: `Feishu webhook HTTP ${response.status}: ${text || response.statusText}`,
          };
        }
        if (isRecord(json)) {
          const code = json.code;
          const statusCode = json.StatusCode;
          if (
            (typeof code === "number" && code !== 0) ||
            (typeof statusCode === "number" && statusCode !== 0)
          ) {
            const msg =
              (typeof json.msg === "string" && json.msg) ||
              (typeof json.StatusMessage === "string" && json.StatusMessage) ||
              JSON.stringify(json);
            return { ok: false, error: `Feishu API error: ${msg}` };
          }
        }
        return { ok: true, externalId: pickExternalId(json, card.id) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export const feishuChannel = createFeishuChannel();

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectToken(body: Record<string, unknown>): string | undefined {
  const header = isRecord(body.header) ? body.header : undefined;
  return (
    asString(body.token) ??
    asString(header?.token) ??
    asString(body.verification_token) ??
    undefined
  );
}

function collectAction(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(body.action)) return body.action;
  const event = isRecord(body.event) ? body.event : undefined;
  if (event && isRecord(event.action)) return event.action;
  return undefined;
}

function collectResponder(body: Record<string, unknown>): string | undefined {
  const event = isRecord(body.event) ? body.event : undefined;
  const operator = isRecord(event?.operator) ? event.operator : undefined;
  return (
    asString(operator?.open_id) ??
    asString(operator?.user_id) ??
    asString(body.open_id) ??
    asString(body.user_id) ??
    asString(body.open_id)
  );
}

export function parseFeishuCallback(
  body: unknown,
  verificationToken?: string,
): FeishuCallbackResult {
  const parsed = parseMaybeJson(body);
  if (!isRecord(parsed)) {
    return { kind: "error", status: 400, error: "Feishu callback body must be a JSON object" };
  }
  if (typeof parsed.encrypt === "string" && !parsed.challenge && !parsed.event && !parsed.action) {
    return {
      kind: "error",
      status: 400,
      error: "Encrypted Feishu callbacks are not supported",
    };
  }

  const providedToken = collectToken(parsed);
  if (verificationToken) {
    if (!providedToken || providedToken !== verificationToken) {
      return { kind: "error", status: 401, error: "Invalid Feishu verification token" };
    }
  }

  const type = asString(parsed.type);
  const challenge = asString(parsed.challenge);
  if (type === "url_verification" || (challenge && !parsed.action && !parsed.event)) {
    if (!challenge) {
      return { kind: "error", status: 400, error: "Missing Feishu URL verification challenge" };
    }
    return { kind: "challenge", challenge };
  }

  const action = collectAction(parsed);
  const rawValue = action ? parseMaybeJson(action.value) : undefined;
  const value = isRecord(rawValue) ? rawValue : undefined;
  const cardId =
    asString(value?.cardId) ??
    asString(value?.card_id) ??
    asString(parsed.cardId) ??
    asString(parsed.card_id);
  if (!cardId) {
    return {
      kind: "error",
      status: 400,
      error: "Feishu callback is missing cardId",
    };
  }

  const choice =
    asString(value?.choice) ??
    asString(action?.option) ??
    asString(action?.name);
  const text =
    asString(value?.text) ??
    asString(action?.input_value) ??
    asString(action?.inputValue);
  const responder = collectResponder(parsed);
  const result: FeishuCallbackResult = { kind: "answer", cardId };
  if (choice) result.choice = choice;
  if (text) result.text = text;
  if (responder) result.responder = responder;
  return result;
}
