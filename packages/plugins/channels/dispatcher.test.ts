import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChannelDispatcher } from "./dispatcher.ts";
import type { AppConfig, Card, ChannelAdapter } from "./types.ts";
import type { CardDelivery } from "./dispatcher.ts";

function sampleCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    runId: "run-1",
    ruleName: "review-pr",
    lane: "main",
    kind: "notice",
    status: "open",
    title: "Done",
    body: "Ship it",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function sampleConfig(): AppConfig {
  return {
    hub: { host: "127.0.0.1", port: 3350, timezone: "Asia/Shanghai" },
    worker: { enabled: true, name: "local", capacity: 2, pollTimeoutMs: 30_000 },
    agents: {},
    channels: { web: { enabled: true }, desktop: { enabled: true } },
    sources: {},
  };
}

function delivery(overrides: Partial<CardDelivery> = {}): CardDelivery {
  const card = overrides.card ?? sampleCard();
  return {
    id: "del-1",
    cardId: card.id,
    channel: "fake",
    ...overrides,
    card,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ChannelDispatcher", () => {
  it("returns empty when the hub has no delivery", async () => {
    const calls: string[] = [];
    const dispatcher = new ChannelDispatcher({
      baseUrl: "http://127.0.0.1:3350/",
      config: sampleConfig(),
      waitMs: 100,
      token: "owner-key",
      fetchFn: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${input}`);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer owner-key");
        return jsonResponse(200, { delivery: null });
      },
    });
    const result = await dispatcher.pollOnce("desktop");
    assert.deepEqual(result, { status: "empty" });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0],
      "GET http://127.0.0.1:3350/v1/cards/next?channel=desktop&wait=100",
    );
  });

  it("dispatches a card and posts /delivered with the external id", async () => {
    const posts: Array<{ url: string; body: unknown; auth?: string }> = [];
    const adapter: ChannelAdapter = {
      name: "fake",
      async sendCard(card) {
        return { ok: true, externalId: `fake:${card.id}` };
      },
    };
    const dispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      token: "t0",
      adapters: { fake: adapter },
      fetchFn: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers);
        if (method === "GET") {
          return jsonResponse(200, { delivery: delivery() });
        }
        posts.push({
          url,
          body: JSON.parse(String(init?.body)),
          auth: headers.get("authorization") ?? undefined,
        });
        return jsonResponse(200, { ok: true });
      },
    });
    const result = await dispatcher.pollOnce("fake");
    assert.equal(result.status, "delivered");
    if (result.status === "delivered") {
      assert.equal(result.externalId, "fake:card-1");
      assert.equal(result.delivery.cardId, "card-1");
    }
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.url, "http://hub.local/v1/cards/card-1/delivered");
    assert.deepEqual(posts[0]?.body, { channel: "fake", externalId: "fake:card-1" });
    assert.equal(posts[0]?.auth, "Bearer t0");
  });

  it("posts /failed when the adapter returns an error or throws", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const failing: ChannelAdapter = {
      name: "fake",
      async sendCard() {
        return { ok: false, error: "boom" };
      },
    };
    const throwing: ChannelAdapter = {
      name: "fake",
      async sendCard() {
        throw new Error("exploded");
      },
    };

    const fetchFn = (adapterResult: "fail" | "throw") =>
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(200, { delivery: delivery() });
        posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, { ok: true });
      };

    const failDispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      adapters: { fake: failing },
      fetchFn: fetchFn("fail"),
    });
    const failed = await failDispatcher.pollOnce("fake");
    assert.equal(failed.status, "failed");
    if (failed.status === "failed") assert.equal(failed.error, "boom");

    const throwDispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      adapters: { fake: throwing },
      fetchFn: fetchFn("throw"),
    });
    const thrown = await throwDispatcher.pollOnce("fake");
    assert.equal(thrown.status, "failed");
    if (thrown.status === "failed") assert.equal(thrown.error, "exploded");

    assert.equal(posts.length, 2);
    for (const post of posts) {
      assert.equal(post.url, "http://hub.local/v1/cards/card-1/failed");
      assert.equal((post.body as { channel: string }).channel, "fake");
    }
  });

  it("posts /failed when no adapter is registered", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const dispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      adapters: {},
      channels: ["missing"],
      fetchFn: async (input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return jsonResponse(200, { delivery: delivery({ channel: "missing" }) });
        }
        posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, { ok: true });
      },
    });
    const result = await dispatcher.pollOnce("missing");
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.error, /No channel adapter/);
    }
    assert.equal(posts[0]?.url, "http://hub.local/v1/cards/card-1/failed");
  });

  it("returns failed when the next-card request errors", async () => {
    const dispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      fetchFn: async () => new Response("down", { status: 503 }),
    });
    const result = await dispatcher.pollOnce("desktop");
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /HTTP 503/);
  });

  it("start and stop are idempotent", () => {
    const dispatcher = new ChannelDispatcher({
      baseUrl: "http://hub.local",
      config: sampleConfig(),
      channels: [],
      fetchFn: async () => jsonResponse(200, { delivery: null }),
    });
    dispatcher.start();
    dispatcher.start();
    assert.equal(dispatcher.running, true);
    dispatcher.stop();
    dispatcher.stop();
    assert.equal(dispatcher.running, false);
  });
});
