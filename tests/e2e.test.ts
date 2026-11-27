import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startStudio, type Studio } from "../packages/host/studio.ts";
import { defaultAppConfig } from "../packages/protocol/validate.ts";
import type { AppConfig, Rule } from "../packages/protocol/types.ts";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fixture = join(root, "tests/fixtures/ask-agent.mjs");

const temps: string[] = [];
const studios: Studio[] = [];
const servers: Server[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}


async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text();
  throw new Error(`${label} HTTP ${res.status}: ${body}`);
}

function listen(server: Server, host = "127.0.0.1"): Promise<string> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      const addr = server.address() as AddressInfo;
      resolve(`http://${host}:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function waitFor<T>(
  fn: () => Promise<T | undefined | false | null> | T | undefined | false | null,
  timeoutMs = 12_000,
  intervalMs = 50,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const extra = lastError instanceof Error ? `: ${lastError.message}` : lastError ? `: ${String(lastError)}` : "";
  throw new Error(`timed out after ${timeoutMs}ms${extra}`);
}

async function readSseEvents(
  url: string,
  signal: AbortSignal,
): Promise<{ events: Array<{ type: string; at: number }>; done: Promise<void> }> {
  const events: Array<{ type: string; at: number }> = [];
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    try {
      while (!signal.aborted) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split(/\r?\n/);
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (eventName === "update" && dataLine) {
            const payload = JSON.parse(dataLine.slice(5).trim()) as { type: string; at: number };
            events.push(payload);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted && !(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  })();
  return { events, done };
}

after(async () => {
  while (studios.length) {
    const studio = studios.pop();
    if (studio) await studio.close().catch(() => undefined);
  }
  while (servers.length) {
    const server = servers.pop();
    if (server) await closeServer(server);
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("end-to-end AutoLoop Studio", () => {
  it("configures the hub, runs ask -> answer -> done, and serves the web console", async () => {
    const dataDir = tempDir("autoloop-e2e-data-");
    const workDir = tempDir("autoloop-e2e-work-");

    const hookBodies: unknown[] = [];
    const hook = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          hookBodies.push(JSON.parse(raw));
        } catch {
          hookBodies.push(raw);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "hook-1" }));
      })();
    });
    const hookUrl = await listen(hook);

    const studio = await startStudio({ host: "127.0.0.1", port: 0, dataDir });
    studios.push(studio);
    const base = studio.url;

    const config: AppConfig = {
      ...defaultAppConfig(),
      hub: {
        host: "127.0.0.1",
        port: studio.port,
        publicUrl: base,
        timezone: "Asia/Shanghai",
      },
      worker: {
        enabled: true,
        name: "e2e-worker",
        capacity: 1,
        pollTimeoutMs: 2000,
      },
      agents: {
        claude: { enabled: false },
        codex: { enabled: false },
        command: { enabled: true },
      },
      channels: {
        web: { enabled: true },
        desktop: { enabled: false },
        webhook: { enabled: true, preset: "custom", urlSecret: "WEBHOOK_URL" },
      },
      sources: {
        github: { enabled: true, webhookSecretKey: "GITHUB_WEBHOOK_SECRET" },
      },
    };

    const putConfig = await fetch(`${base}/v1/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    await assertOk(putConfig, 'putConfig');
    const savedConfig = (await putConfig.json()) as { ok: boolean; config: AppConfig };
    assert.equal(savedConfig.ok, true);
    assert.equal(savedConfig.config.worker.name, "e2e-worker");

    const secretValue = "e2e-github-secret";
    const putSecrets = await fetch(`${base}/v1/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        set: {
          GITHUB_WEBHOOK_SECRET: secretValue,
          WEBHOOK_URL: hookUrl,
        },
      }),
    });
    await assertOk(putSecrets, 'putSecrets');
    const listed = await fetch(`${base}/v1/secrets`);
    assert.equal(listed.status, 200);
    const secretBody = await listed.text();
    assert.equal(secretBody.includes(secretValue), false);
    assert.equal(secretBody.includes(hookUrl), false);
    const secretJson = JSON.parse(secretBody) as { keys: Array<{ name: string; configured: boolean }> };
    assert.deepEqual(
      secretJson.keys.map((key) => key.name).sort(),
      ["GITHUB_WEBHOOK_SECRET", "WEBHOOK_URL"],
    );
    assert.ok(secretJson.keys.every((key) => key.configured));

    const rule: Rule = {
      name: "e2e-triage",
      enabled: true,
      description: "End-to-end ask/answer loop",
      trigger: { type: "event", source: "github", eventType: "issues.opened" },
      agent: {
        adapter: "command",
        cwd: workDir,
        access: "plan",
        prompt: "Triage the issue and ask before finishing.",
        command: ["node", fixture],
        timeoutMinutes: 1,
      },
      channels: ["web", "webhook"],
    };
    const putRules = await fetch(`${base}/v1/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [rule] }),
    });
    await assertOk(putRules, 'putRules');
    await studio.whenSynced();

    const sseController = new AbortController();
    const stream = await readSseEvents(`${base}/v1/stream`, sseController.signal);

    const payload = {
      action: "opened",
      issue: { number: 77, title: "ship it" },
      repository: { full_name: "acme/studio" },
    };
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", secretValue).update(raw).digest("hex")}`;

    const denied = await fetch(`${base}/v1/in/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "e2e-77",
        "X-Hub-Signature-256": "sha256=" + "00".repeat(32),
      },
      body: raw,
    });
    assert.equal(denied.status, 401);

    const inbound = await fetch(`${base}/v1/in/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "e2e-77",
        "X-Hub-Signature-256": signature,
      },
      body: raw,
    });
    await assertOk(inbound, 'inbound');
    const ingested = (await inbound.json()) as { eventIds: string[]; queued: boolean };
    assert.equal(ingested.queued, true);

    const askCard = await waitFor(async () => {
      const res = await fetch(`${base}/v1/cards?status=open`);
      const body = (await res.json()) as { cards: Array<{ id: string; kind: string; title: string; status: string; options?: string[] }> };
      return body.cards.find((card) => card.kind === "ask" && card.status === "open");
    });
    assert.equal(askCard.title, "Approve deploy?");
    assert.deepEqual(askCard.options, ["yes", "no"]);

    await waitFor(() => hookBodies.find((item) => typeof item === "object" && item !== null && (item as { event?: string }).event === "card.created"));

    const db = new DatabaseSync(join(dataDir, "hub.db"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(String(mode.journal_mode).toLowerCase(), "wal");
    db.close();

    const answered = await fetch(`${base}/v1/cards/${encodeURIComponent(askCard.id)}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "yes", text: "ship it", responder: "e2e" }),
    });
    await assertOk(answered, 'answered');
    const answerJson = (await answered.json()) as { ok: boolean; resumedRunId?: string };
    assert.equal(answerJson.ok, true);
    assert.ok(answerJson.resumedRunId);

    const finished = await waitFor(async () => {
      const res = await fetch(`${base}/v1/runs`);
      const body = (await res.json()) as {
        runs: Array<{ id: string; status: string; sessionId?: string; outcome?: string }>;
      };
      const resumed = body.runs.find((run) => run.id === answerJson.resumedRunId);
      if (resumed && (resumed.status === "done" || resumed.status === "failed" || resumed.status === "cancelled")) {
        return resumed;
      }
      return undefined;
    });
    assert.equal(finished.status, "done");
    assert.equal(finished.sessionId, "e2e-session");
    assert.equal(finished.outcome, "done");

    const stateRes = await fetch(`${base}/v1/state`);
    assert.equal(stateRes.status, 200);
    const state = (await stateRes.json()) as {
      config: AppConfig;
      rules: Rule[];
      runs: Array<{ id: string; status: string; sessionId?: string }>;
      cards: Array<{ id: string; kind: string; status: string }>;
      workers: Array<{ name: string }>;
      stats: { totalRuns: number; openCards: number; totalEvents: number };
    };
    assert.equal(state.config.worker.name, "e2e-worker");
    assert.equal(state.rules[0]?.name, "e2e-triage");
    assert.ok(state.runs.some((run) => run.id === answerJson.resumedRunId && run.status === "done" && run.sessionId === "e2e-session"));
    assert.ok(state.workers.some((worker) => worker.name === "e2e-worker"));
    assert.ok(state.stats.totalRuns >= 2);
    assert.ok(state.stats.totalEvents >= 1);
    const decided = state.cards.find((card) => card.id === askCard.id);
    assert.ok(decided);
    assert.notEqual(decided?.status, "open");
    const notice = state.cards.find((card) => card.kind === "notice");
    assert.ok(notice);

    await waitFor(() => stream.events.some((event) => event.type === "event.recorded"));
    assert.ok(stream.events.some((event) => event.type === "run.queued"));
    assert.ok(stream.events.some((event) => event.type === "card.created"));
    assert.ok(stream.events.some((event) => event.type === "card.answered"));
    sseController.abort();
    await stream.done.catch(() => undefined);

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    const html = await home.text();
    assert.match(html, /AutoLoop Studio/);
    assert.match(html, /<div id="root">/);
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/);
    assert.ok(asset);
    const js = await fetch(`${base}${asset![1]}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = (await health.json()) as { ok: boolean; version: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.version, "0.1.0");

    await studio.close();
    studios.pop();
    await closeServer(hook);
    const idx = servers.indexOf(hook);
    if (idx >= 0) servers.splice(idx, 1);

    const envText = readFileSync(join(dataDir, "secrets.env"), "utf8");
    assert.match(envText, /GITHUB_WEBHOOK_SECRET=/);
  });
});
