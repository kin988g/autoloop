import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HubClient, HubError } from "../protocol/client.ts";
import type { Rule } from "../protocol/types.ts";
import { startHub, type HubServer } from "./server.ts";
import { Runtime } from "./runtime.ts";

const rule: Rule = {
  name: "triage",
  enabled: true,
  trigger: { type: "event", source: "github", eventType: "issue.opened" },
  agent: {
    adapter: "command",
    cwd: "/tmp/work",
    access: "plan",
    prompt: "Triage the issue.",
    command: ["echo", "{prompt}"],
    timeoutMinutes: 30,
  },
  channels: ["web"],
  laneKey: "issue",
};

const temps: string[] = [];
const servers: HubServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-host-"));
  temps.push(dir);
  return dir;
}

async function boot(options: { rules?: Rule[]; requireAuth?: boolean; token?: string } = {}) {
  const dataDir = tempDir();
  const runtime = new Runtime({ dataDir });
  if (options.rules) runtime.setRules({ rules: options.rules });
  const server = await startHub({ host: "127.0.0.1", port: 0, runtime });
  servers.push(server);
  const client = new HubClient({ baseUrl: server.url, token: options.token });
  return { dataDir, runtime, server, client };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("host HTTP API", () => {
  it("serves healthz, CORS preflight, config, rules, and secrets", async () => {
    const { client, server, dataDir } = await boot({ rules: [rule] });
    const health = await client.healthz();
    assert.equal(health.ok, true);
    assert.equal(health.version, "0.1.0");
    assert.ok(health.uptimeMs >= 0);

    const preflight = await fetch(`${server.url}/v1/state`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PUT/);

    const config = await client.getConfig();
    assert.equal(config.config.hub.port, 3350);
    const updated = await client.putConfig({
      ...config.config,
      hub: { ...config.config.hub, publicUrl: "http://127.0.0.1:3350" },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.config.hub.publicUrl, "http://127.0.0.1:3350");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).hub.publicUrl, "http://127.0.0.1:3350");

    const rules = await client.getRules();
    assert.equal(rules.rules[0].name, "triage");
    await client.putRules({ rules: [{ ...rule, description: "updated" }] });
    assert.equal((await client.getRules()).rules[0].description, "updated");

    const secrets = await client.putSecrets({ set: { GITHUB_TOKEN: "super-secret", HOOK: "x" } });
    assert.deepEqual(
      secrets.keys.map((key) => key.name).sort(),
      ["GITHUB_TOKEN", "HOOK"],
    );
    assert.ok(secrets.keys.every((key) => key.configured));
    const listed = await client.getSecrets();
    const blob = JSON.stringify(listed);
    assert.equal(blob.includes("super-secret"), false);
    const envText = readFileSync(join(dataDir, "secrets.env"), "utf8");
    assert.match(envText, /GITHUB_TOKEN=super-secret/);
    await client.putSecrets({ unset: ["HOOK"] });
    assert.equal((await client.getSecrets()).keys.some((key) => key.name === "HOOK"), false);
  });

  it("runs event ingest, work claim, result, and SQLite persistence", async () => {
    const { client, dataDir, server } = await boot({ rules: [rule] });
    const posted = await client.postEvent({
      type: "issue.opened",
      source: "github",
      payload: { issue: "11" },
      dedupeKey: "gh:11",
    });
    assert.equal(posted.queued, true);
    assert.ok(posted.runId);

    const dup = await client.postEvent({
      type: "issue.opened",
      source: "github",
      payload: { issue: "11" },
      dedupeKey: "gh:11",
    });
    assert.equal(dup.eventId, posted.eventId);
    assert.equal(dup.queued, false);

    const { job } = await client.getWork({ worker: "alpha", capacity: 1 });
    assert.ok(job);
    assert.equal(job?.runId, posted.runId);
    assert.equal(job?.lane, "11");
    assert.equal(job?.rule.name, "triage");
    await client.started(job!.runId, { runToken: job!.runToken });
    const result = await client.result(job!.runId, {
      outcome: "done",
      sessionId: "sess-persist",
      receipt: { notice: { title: "ok", body: "closed" } },
    });
    assert.equal(result.ok, true);
    assert.ok(result.cardId);

    const db = new DatabaseSync(join(dataDir, "hub.db"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(String(mode.journal_mode).toLowerCase(), "wal");
    const facts = db.prepare("SELECT COUNT(*) AS n FROM fact_log").get() as { n: number };
    assert.ok(Number(facts.n) >= 1);
    db.close();

    await server.close();
    const again = new Runtime({ dataDir });
    assert.equal(again.view.events.length, 1);
    assert.equal(again.view.runs[0].sessionId, "sess-persist");
    assert.equal(again.view.cards[0].title, "ok");
    again.close();
  });

  it("covers ask -> answer -> resume, deliveries, and long polling", async () => {
    const { client } = await boot({ rules: [rule] });
    await client.postEvent({ type: "issue.opened", source: "github", payload: { issue: "21" } });
    const { job } = await client.getWork({ worker: "w", capacity: 1 });
    assert.ok(job);
    const finished = await client.result(job!.runId, {
      outcome: "done",
      sessionId: "sess-ask",
      receipt: { ask: { title: "Approve?", body: "Merge?", options: ["yes", "no"] } },
    });
    assert.ok(finished.cardId);
    const open = await client.listCards({ status: "open" });
    assert.equal(open.cards[0].kind, "ask");

    const next = await client.nextCard({ channel: "web" });
    assert.ok(next.delivery);
    assert.equal(next.delivery?.cardId, finished.cardId);
    await client.delivered(finished.cardId!, { channel: "web", externalId: "msg-1" });

    const answered = await client.answer(finished.cardId!, { choice: "yes", text: "lgtm", responder: "kai" });
    assert.ok(answered.resumedRunId);
    const resumed = await client.getWork({ worker: "w", capacity: 1 });
    assert.equal(resumed.job?.runId, answered.resumedRunId);
    assert.equal(resumed.job?.sessionId, "sess-ask");
    assert.equal(resumed.job?.context.answer?.choice, "yes");

    const pending = client.getWork({ worker: "idle", capacity: 1, wait: 2000 });
    const started = Date.now();
    await client.postEvent({ type: "issue.opened", source: "github", payload: { issue: "22" } });
    const woken = await pending;
    assert.ok(woken.job);
    assert.equal(woken.job?.lane, "22");
    assert.ok(Date.now() - started < 1800);
  });

  it("pushes SSE updates", async () => {
    const { client, server } = await boot({ rules: [rule] });
    const response = await fetch(`${server.url}/v1/stream`, { headers: { Accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const arrived = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return buffer;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("event: update") && buffer.includes("event.recorded")) return buffer;
      }
    })();
    await client.postEvent({ type: "issue.opened", source: "github", payload: { issue: "31" } });
    const text = await Promise.race([
      arrived,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("sse timeout")), 2000)),
    ]);
    assert.match(text, /event: update/);
    assert.match(text, /event\.recorded/);
    await reader.cancel();
  });

  it("supports inbound webhooks, pause/resume/run, cancel, and state", async () => {
    const { client } = await boot({ rules: [rule] });
    const githubRule = {
      ...rule,
      trigger: { type: "event" as const, source: "github", eventType: "issues.opened" },
    };
    await client.putRules({ rules: [githubRule] });
    await client.putSecrets({ set: { GITHUB_SECRET: "whsec-test" } });
    const cfg = await client.getConfig();
    await client.putConfig({
      ...cfg.config,
      sources: { github: { enabled: true, webhookSecretKey: "GITHUB_SECRET" } },
    });

    const payload = {
      action: "opened",
      issue: { number: 41 },
      repository: { full_name: "acme/app" },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "whsec-test").update(body).digest("hex")}`;
    const inbound = await client.ingest("github", body, {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "in-41",
      "x-hub-signature-256": signature,
    });
    assert.equal(inbound.queued, true);
    const state = await client.state();
    assert.ok(state.stats.totalEvents >= 1);
    assert.ok(state.stats.activeRuns >= 1);

    await client.pauseRule("triage");
    const paused = await client.postEvent({
      type: "issues.opened",
      source: "github",
      payload: { issue: "42" },
      dedupeKey: "paused-42",
    });
    assert.equal(paused.queued, false);
    await client.resumeRule("triage");
    const manual = await client.runRule("triage", { reason: "now" });
    assert.ok(manual.runId);
    await client.cancel(manual.runId!);
    const runs = await client.listRuns({ rule: "triage", status: "cancelled" });
    assert.ok(runs.runs.length >= 1);

    const work = await client.getWork({ worker: "w", capacity: 1 });
    if (work.job) await client.cancel(work.job.runId);
  });

  it("enforces bearer auth when AUTOLOOP_REQUIRE_AUTH=1", async () => {
    const previous = process.env.AUTOLOOP_REQUIRE_AUTH;
    const previousKey = process.env.AUTOLOOP_AUTH_KEY;
    process.env.AUTOLOOP_REQUIRE_AUTH = "1";
    process.env.AUTOLOOP_AUTH_KEY = "test-owner-key";
    try {
      const { server } = await boot();
      const denied = await fetch(`${server.url}/healthz`);
      assert.equal(denied.status, 401);
      const ok = await fetch(`${server.url}/healthz`, { headers: { Authorization: "Bearer test-owner-key" } });
      assert.equal(ok.status, 200);
      const bad = await fetch(`${server.url}/healthz`, { headers: { Authorization: "Bearer no-such-key" } });
      assert.equal(bad.status, 401);
    } finally {
      if (previous === undefined) delete process.env.AUTOLOOP_REQUIRE_AUTH;
      else process.env.AUTOLOOP_REQUIRE_AUTH = previous;
      if (previousKey === undefined) delete process.env.AUTOLOOP_AUTH_KEY;
      else process.env.AUTOLOOP_AUTH_KEY = previousKey;
    }
  });

  it("rejects invalid rule documents", async () => {
    const { client } = await boot();
    await assert.rejects(() => client.putRules({ rules: [{ name: "bad" }] as unknown as Rule[] }), (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.equal((error as HubError).status, 400);
      return true;
    });
  });
});
