import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCardUrl,
  buildFeishuCardPayload,
  buildWebhookPayload,
  channelAdapters,
  createDesktopChannel,
  createFeishuChannel,
  createWebhookChannel,
  desktopChannel,
  feishuChannel,
  getChannelAdapter,
  parseFeishuCallback,
  renderWebhookTemplate,
  webhookChannel,
} from "./index.ts";
import type { AppConfig, Card } from "./types.ts";

function sampleCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    runId: "run-1",
    ruleName: "review-pr",
    lane: "acme/widgets#42",
    kind: "ask",
    status: "open",
    title: "Merge this PR?",
    body: "Please review the change.",
    options: ["Approve", "Reject"],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function sampleConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hub: {
      host: "127.0.0.1",
      port: 3350,
      timezone: "Asia/Shanghai",
      publicUrl: "https://hub.example/",
    },
    worker: {
      enabled: true,
      name: "local",
      capacity: 2,
      pollTimeoutMs: 30_000,
    },
    agents: {},
    channels: {
      web: { enabled: true },
      desktop: { enabled: true },
      feishu: { enabled: true, webhookUrlSecret: "FEISHU_URL" },
      webhook: { enabled: true, preset: "custom", urlSecret: "HOOK_URL" },
    },
    sources: {},
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildCardUrl", () => {
  it("uses publicUrl without a trailing slash", () => {
    const url = buildCardUrl(sampleCard({ id: "a/b" }), sampleConfig());
    assert.equal(url, "https://hub.example/#cards/a%2Fb");
  });

  it("falls back to host and port", () => {
    const config = sampleConfig();
    delete config.hub.publicUrl;
    const url = buildCardUrl(sampleCard(), config);
    assert.equal(url, "http://127.0.0.1:3350/#cards/card-1");
  });
});

describe("desktop channel", () => {
  it("sends a macOS notification with escaped quotes and backslashes", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const channel = createDesktopChannel({
      platform: "darwin",
      execFileFn: async (file, args) => {
        calls.push({ file, args });
        return {};
      },
    });
    const card = sampleCard({
      title: 'Title "quoted"',
      body: 'Body with \\ slash and "quotes"',
    });
    const result = await channel.sendCard(card, sampleConfig(), {});
    assert.deepEqual(result, { ok: true, externalId: "desktop:card-1" });
    assert.equal(calls[0]?.file, "osascript");
    assert.equal(calls[0]?.args[0], "-e");
    const script = String(calls[0]?.args[1]);
    assert.match(script, /display notification "/);
    assert.match(script, /with title "/);
    assert.match(script, /subtitle "/);
    assert.ok(script.includes('\\"quoted\\"'));
    assert.ok(script.includes('\\\\ slash'));
  });

  it("sends a Linux notification with title and body args", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const channel = createDesktopChannel({
      platform: "linux",
      execFileFn: async (file, args) => {
        calls.push({ file, args });
        return {};
      },
    });
    const result = await channel.sendCard(
      sampleCard({ title: "Hello", body: "World" }),
      sampleConfig(),
      {},
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], { file: "notify-send", args: ["Hello", "World"] });
  });

  it("sends a Windows balloon notification and escapes single quotes", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const channel = createDesktopChannel({
      platform: "win32",
      execFileFn: async (file, args) => {
        calls.push({ file, args });
        return {};
      },
    });
    const result = await channel.sendCard(
      sampleCard({ title: "O'Reilly", body: "it's fine" }),
      sampleConfig(),
      {},
    );
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.file, "powershell.exe");
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    const command = String(calls[0]?.args[3]);
    assert.ok(command.includes("$title = 'O''Reilly'"));
    assert.ok(command.includes("$body = 'it''s fine'"));
  });

  it("returns a disabled error when the desktop channel is off", async () => {
    const channel = createDesktopChannel({
      platform: "linux",
      execFileFn: async () => {
        throw new Error("should not run");
      },
    });
    const config = sampleConfig();
    config.channels.desktop.enabled = false;
    const result = await channel.sendCard(sampleCard(), config, {});
    assert.deepEqual(result, { ok: false, error: "Desktop channel is disabled" });
  });

  it("surfaces exec errors and rejects unsupported platforms", async () => {
    const failing = createDesktopChannel({
      platform: "linux",
      execFileFn: async () => {
        throw new Error("notify-send missing");
      },
    });
    const failed = await failing.sendCard(sampleCard(), sampleConfig(), {});
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "notify-send missing");

    const other = createDesktopChannel({ platform: "freebsd" as typeof process.platform });
    const unsupported = await other.sendCard(sampleCard(), sampleConfig(), {});
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, "Unsupported platform: freebsd");
  });
});

describe("feishu channel", () => {
  it("builds ask and notice interactive card payloads", () => {
    const config = sampleConfig();
    const ask = buildFeishuCardPayload(sampleCard(), config);
    assert.equal(ask.msg_type, "interactive");
    const askCard = ask.card as {
      header: { title: { content: string }; template: string };
      elements: Array<Record<string, unknown>>;
    };
    assert.equal(askCard.header.title.content, "[需拍板] Merge this PR?");
    assert.equal(askCard.header.template, "orange");
    const note = JSON.stringify(askCard.elements);
    assert.match(note, /规则: review-pr/);
    assert.match(note, /车道: acme\/widgets#42/);
    assert.match(note, /1\. Approve/);
    assert.match(note, /打开卡片/);
    assert.match(note, /https:\/\/hub\.example\/#cards\/card-1/);

    const notice = buildFeishuCardPayload(
      sampleCard({ kind: "notice", title: "Deployed", options: undefined }),
      config,
    );
    const noticeCard = notice.card as { header: { title: { content: string }; template: string } };
    assert.equal(noticeCard.header.title.content, "[通知] Deployed");
    assert.equal(noticeCard.header.template, "blue");
  });

  it("returns an error when disabled or the webhook URL is missing", async () => {
    const channel = createFeishuChannel({
      fetchFn: async () => {
        throw new Error("should not fetch");
      },
    });
    const disabledConfig = sampleConfig();
    disabledConfig.channels.feishu = { enabled: false };
    const disabled = await channel.sendCard(sampleCard(), disabledConfig, {
      FEISHU_URL: "https://open.feishu.cn/hook",
    });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.error, "Feishu channel is disabled");

    const missing = await channel.sendCard(sampleCard(), sampleConfig(), {});
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "Feishu webhook URL is not configured");
  });

  it("returns HTTP and API errors, and succeeds with an external id", async () => {
    const httpChannel = createFeishuChannel({
      fetchFn: async () => new Response("nope", { status: 500, statusText: "ERR" }),
    });
    const httpErr = await httpChannel.sendCard(sampleCard(), sampleConfig(), {
      FEISHU_URL: "https://open.feishu.cn/hook",
    });
    assert.equal(httpErr.ok, false);
    assert.match(String(httpErr.error), /HTTP 500/);

    const apiChannel = createFeishuChannel({
      fetchFn: async () => jsonResponse(200, { code: 19001, msg: "invalid" }),
    });
    const apiErr = await apiChannel.sendCard(sampleCard(), sampleConfig(), {
      FEISHU_URL: "https://open.feishu.cn/hook",
    });
    assert.equal(apiErr.ok, false);
    assert.match(String(apiErr.error), /invalid/);

    let posted: unknown;
    const okChannel = createFeishuChannel({
      fetchFn: async (_input, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse(200, { code: 0, data: { message_id: "om_123" } });
      },
    });
    const ok = await okChannel.sendCard(sampleCard(), sampleConfig(), {
      FEISHU_URL: "https://open.feishu.cn/hook",
    });
    assert.deepEqual(ok, { ok: true, externalId: "feishu:om_123" });
    assert.equal((posted as { msg_type: string }).msg_type, "interactive");
  });

  it("accepts StatusCode 0 responses", async () => {
    const channel = createFeishuChannel({
      fetchFn: async () => jsonResponse(200, { StatusCode: 0 }),
    });
    const result = await channel.sendCard(sampleCard(), sampleConfig(), {
      FEISHU_WEBHOOK_URL: "https://open.feishu.cn/hook",
    });
    assert.equal(result.ok, true);
    assert.equal(result.externalId, "feishu:card-1");
  });
});

describe("parseFeishuCallback", () => {
  it("handles URL verification challenges", () => {
    const result = parseFeishuCallback({
      type: "url_verification",
      challenge: "abc-123",
      token: "verify-me",
    }, "verify-me");
    assert.deepEqual(result, { kind: "challenge", challenge: "abc-123" });
  });

  it("rejects a mismatched verification token", () => {
    const result = parseFeishuCallback({
      type: "url_verification",
      challenge: "abc-123",
      token: "wrong",
    }, "verify-me");
    assert.deepEqual(result, {
      kind: "error",
      status: 401,
      error: "Invalid Feishu verification token",
    });
  });

  it("extracts answers from interactive card actions", () => {
    const legacy = parseFeishuCallback({
      open_id: "ou_1",
      action: { value: { cardId: "card-1", choice: "Approve" }, tag: "button" },
    });
    assert.deepEqual(legacy, {
      kind: "answer",
      cardId: "card-1",
      choice: "Approve",
      responder: "ou_1",
    });

    const modern = parseFeishuCallback({
      schema: "2.0",
      header: { event_type: "card.action.trigger", token: "verify-me" },
      event: {
        operator: { open_id: "ou_9" },
        action: {
          value: JSON.stringify({ cardId: "card-2" }),
          input_value: "looks good",
        },
      },
    }, "verify-me");
    assert.deepEqual(modern, {
      kind: "answer",
      cardId: "card-2",
      text: "looks good",
      responder: "ou_9",
    });
  });

  it("returns errors for invalid bodies and missing card ids", () => {
    const invalid = parseFeishuCallback("not-json");
    assert.equal(invalid.kind, "error");
    if (invalid.kind === "error") assert.equal(invalid.status, 400);

    const missing = parseFeishuCallback({ action: { value: { choice: "x" } } });
    assert.deepEqual(missing, {
      kind: "error",
      status: 400,
      error: "Feishu callback is missing cardId",
    });
  });
});

describe("webhook channel", () => {
  const card = sampleCard();
  const config = sampleConfig();

  it("renders templates safely and leaves unknown placeholders", () => {
    assert.equal(
      renderWebhookTemplate("Hello {{name}} from {{place}}", { name: "Kai" }),
      "Hello Kai from {{place}}",
    );
    assert.equal(
      renderWebhookTemplate("{{__proto__}} {{toString}}", { title: "x" }),
      "{{__proto__}} {{toString}}",
    );
  });

  it("builds all five webhook presets", () => {
    const dingtalk = buildWebhookPayload("dingtalk", card, config);
    assert.equal(dingtalk.msgtype, "markdown");
    const dingMd = dingtalk.markdown as { title: string; text: string };
    assert.match(dingMd.title, /需拍板/);
    assert.match(dingMd.text, /打开卡片/);

    const wecom = buildWebhookPayload("wecom", card, config);
    assert.equal(wecom.msgtype, "markdown");
    assert.match((wecom.markdown as { content: string }).content, /Merge this PR/);

    const slack = buildWebhookPayload("slack", card, config);
    assert.ok(typeof slack.text === "string");
    assert.ok(Array.isArray(slack.blocks));

    const discord = buildWebhookPayload("discord", card, config);
    const embed = (discord.embeds as Array<{ title: string; color: number; url: string }>)[0];
    assert.equal(embed?.title, "Merge this PR?");
    assert.equal(embed?.color, 0xe67e22);
    assert.equal(embed?.url, "https://hub.example/#cards/card-1");

    const custom = buildWebhookPayload("custom", card, config);
    assert.deepEqual(custom, {
      event: "card.created",
      card,
      cardUrl: "https://hub.example/#cards/card-1",
    });
  });

  it("returns errors when disabled, unconfigured, or HTTP fails, and succeeds otherwise", async () => {
    const disabledConfig = sampleConfig();
    disabledConfig.channels.webhook = { enabled: false };
    const channel = createWebhookChannel({
      fetchFn: async () => {
        throw new Error("should not fetch");
      },
    });
    const disabled = await channel.sendCard(card, disabledConfig, { HOOK_URL: "https://example/hook" });
    assert.equal(disabled.error, "Webhook channel is disabled");

    const missing = await channel.sendCard(card, sampleConfig(), {});
    assert.equal(missing.error, "Webhook URL is not configured");

    const httpChannel = createWebhookChannel({
      fetchFn: async () => new Response("bad", { status: 502 }),
    });
    const httpErr = await httpChannel.sendCard(card, sampleConfig(), { HOOK_URL: "https://example/hook" });
    assert.equal(httpErr.ok, false);
    assert.match(String(httpErr.error), /HTTP 502/);

    let posted: unknown;
    const okChannel = createWebhookChannel({
      fetchFn: async (_input, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse(200, { id: "msg-9" });
      },
    });
    const ok = await okChannel.sendCard(card, sampleConfig(), { HOOK_URL: "https://example/hook" });
    assert.deepEqual(ok, { ok: true, externalId: "webhook:msg-9" });
    assert.equal((posted as { event: string }).event, "card.created");
  });

  it("falls back to WEBHOOK_URL when urlSecret is unset", async () => {
    const configNoSecret = sampleConfig();
    configNoSecret.channels.webhook = { enabled: true, preset: "dingtalk" };
    let url = "";
    const channel = createWebhookChannel({
      fetchFn: async (input) => {
        url = String(input);
        return new Response("{}", { status: 200 });
      },
    });
    const result = await channel.sendCard(card, configNoSecret, {
      WEBHOOK_URL: "https://oapi.dingtalk.com/robot",
    });
    assert.equal(result.ok, true);
    assert.equal(url, "https://oapi.dingtalk.com/robot");
    assert.equal(result.externalId, "webhook:card-1");
  });
});

describe("channel adapter registry", () => {
  it("looks up desktop, feishu, and webhook adapters", () => {
    assert.equal(getChannelAdapter("desktop"), desktopChannel);
    assert.equal(getChannelAdapter("feishu"), feishuChannel);
    assert.equal(getChannelAdapter("webhook"), webhookChannel);
    assert.equal(getChannelAdapter("Feishu")?.name, "feishu");
    assert.equal(getChannelAdapter("unknown"), undefined);
    assert.equal(channelAdapters.desktop?.name, "desktop");
  });
});
