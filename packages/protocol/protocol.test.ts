import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultAppConfig,
  isValidTimeZone,
  nextCronAt,
  parseCron,
  parseReceipt,
  validateAppConfig,
  validateRule,
  validateRules,
} from "./index.ts";

const baseRule = {
  name: "triage",
  enabled: true,
  trigger: { type: "event" as const, source: "github", eventType: "issue.opened" },
  agent: {
    adapter: "command" as const,
    cwd: "/tmp/work",
    access: "plan" as const,
    prompt: "Triage the issue.",
    command: ["echo", "{prompt}"],
  },
  channels: ["web"],
};

describe("validateRule / validateRules", () => {
  it("accepts a complete rule and fills timeoutMinutes", () => {
    const result = validateRule(baseRule);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.agent.timeoutMinutes, 180);
      assert.equal(result.value.channels[0], "web");
    }
  });

  it("rejects unknown trigger types and invalid cron", () => {
    assert.equal(validateRule({ ...baseRule, trigger: { type: "push" } }).ok, false);
    assert.equal(
      validateRule({
        ...baseRule,
        trigger: { type: "cron", cron: "not-a-cron" },
      }).ok,
      false,
    );
  });

  it("requires command arrays for the command adapter", () => {
    const result = validateRule({
      ...baseRule,
      agent: { ...baseRule.agent, command: undefined },
    });
    assert.equal(result.ok, false);
  });

  it("accepts the doubao adapter and an optional model", () => {
    const result = validateRule({
      ...baseRule,
      agent: {
        adapter: "doubao",
        cwd: "/tmp/work",
        access: "acceptEdits",
        prompt: "Summarize the news.",
        model: "doubao-seed-1-6-250615",
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.agent.adapter, "doubao");
      assert.equal(result.value.agent.model, "doubao-seed-1-6-250615");
    }
  });

  it("accepts the cursor adapter and an optional model", () => {
    const result = validateRule({
      ...baseRule,
      agent: {
        adapter: "cursor",
        cwd: "/tmp/work",
        access: "acceptEdits",
        prompt: "Review the diff.",
        model: "composer-1",
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.agent.adapter, "cursor");
      assert.equal(result.value.agent.model, "composer-1");
    }
  });

  it("validates a rules document and rejects duplicates", () => {
    const ok = validateRules({ rules: [baseRule] });
    assert.equal(ok.ok, true);
    const dup = validateRules({ rules: [baseRule, { ...baseRule }] });
    assert.equal(dup.ok, false);
  });
});

describe("validateAppConfig / defaultAppConfig", () => {
  it("provides hub defaults", () => {
    const config = defaultAppConfig();
    assert.equal(config.hub.host, "127.0.0.1");
    assert.equal(config.hub.port, 3350);
    assert.equal(config.hub.timezone, "Asia/Shanghai");
    assert.equal(config.worker.capacity, 2);
    assert.equal(config.agents.doubao?.enabled, false);
    assert.equal(config.agents.doubao?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
    assert.equal(config.agents.doubao?.model, "doubao-seed-1-6-250615");
    assert.equal(config.agents.doubao?.apiKeySecret, "ARK_API_KEY");
  });

  it("fills missing sections and rejects a bad timezone", () => {
    const ok = validateAppConfig({ hub: { port: 4000 } });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.value.hub.port, 4000);
      assert.equal(ok.value.hub.host, "127.0.0.1");
      assert.equal(ok.value.agents.doubao?.enabled, false);
      assert.equal(ok.value.agents.doubao?.apiKeySecret, "ARK_API_KEY");
    }
    assert.equal(validateAppConfig({ hub: { timezone: "Not/AZone" } }).ok, false);
  });
});

describe("parseReceipt", () => {
  it("extracts the last agent-autoloop fence", () => {
    const text = [
      "Working...",
      "```agent-autoloop",
      JSON.stringify({ notice: { title: "first", body: "no" } }),
      "```",
      "Done.",
      "```agent-autoloop",
      JSON.stringify({
        ask: { title: "Ship?", body: "Choose a method", options: ["Courier", "Pickup"] },
        later: { delaySeconds: 60, reason: "recheck stock" },
      }),
      "```",
    ].join("\n");
    const receipt = parseReceipt(text);
    assert.ok(receipt);
    assert.equal(receipt?.ask?.title, "Ship?");
    assert.equal(receipt?.later?.delaySeconds, 60);
    assert.equal(receipt?.notice, undefined);
  });

  it("returns undefined for missing or invalid fences", () => {
    assert.equal(parseReceipt("no fence here"), undefined);
    assert.equal(parseReceipt("```agent-autoloop\n{not json}\n```"), undefined);
    assert.equal(parseReceipt("```agent-autoloop\n{\"ask\": {\"title\": 1}}\n```"), undefined);
  });
});

describe("cron", () => {
  it("parses 5-field expressions including ranges, lists, and steps", () => {
    const star = parseCron("0 9 * * *");
    assert.ok(star);
    assert.deepEqual(star?.minutes, [0]);
    assert.deepEqual(star?.hours, [9]);
    assert.ok(parseCron("*/15 9-17 1,15 * 1-5"));
    assert.equal(parseCron("0 9 * *"), undefined);
    assert.equal(parseCron("60 9 * * *"), undefined);
  });

  it("computes the next fire in Asia/Shanghai", () => {
    assert.equal(isValidTimeZone("Asia/Shanghai"), true);
    // 2026-11-26 08:00 CST == 2026-11-26 00:00 UTC
    const after = Date.parse("2026-11-26T00:00:00Z");
    const next = nextCronAt("0 9 * * *", after, "Asia/Shanghai");
    assert.equal(next, Date.parse("2026-11-26T01:00:00Z"));
    const later = nextCronAt("0 9 * * *", Date.parse("2026-11-26T01:00:00Z"), "Asia/Shanghai");
    assert.equal(later, Date.parse("2026-11-27T01:00:00Z"));
  });
});
