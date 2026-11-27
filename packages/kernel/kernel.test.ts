import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { decide, buildJob, DecisionError } from "./decide.ts";
import { emptyView, evolve } from "./evolve.ts";
import { MemoryStore } from "./store.ts";
import type { Rule } from "../protocol/types.ts";

const rule = (over: Partial<Rule> & Pick<Rule, "name" | "trigger">): Rule => ({
  enabled: true,
  agent: {
    adapter: "command",
    cwd: "/tmp/work",
    access: "plan",
    prompt: "Handle it.",
    command: ["echo", "{prompt}"],
    timeoutMinutes: 30,
  },
  channels: ["web", "desktop"],
  ...over,
});

const triage = rule({
  name: "triage",
  trigger: { type: "event", source: "github", eventType: "issue.opened" },
  laneKey: "issue",
});

const NOW = 1_700_000_000_000;

describe("purity", () => {
  it("decision and evolution modules stay deterministic", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const banned = [
      /Date\.now\s*\(/,
      /Math\.random\s*\(/,
      /new\s+Date\s*\(\s*\)/,
      /\bfetch\s*\(/,
      /node:http/,
      /node:net/,
      /node:fs/,
      /node:dgram/,
      /AutoLoop/i,
      /\bClaude\b/,
      /\bCodex\b/,
      /\bFeishu\b/,
    ];
    const checked = files.filter((name) => ["decide.ts", "evolve.ts", "store.ts", "rules.ts"].includes(name));
    assert.ok(checked.length >= 3);
    for (const name of checked) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const pattern of banned) {
        assert.equal(pattern.test(text), false, `${name} contains ${pattern}`);
      }
    }
  });
});

describe("decide / evolve", () => {
  it("is deterministic for the same view, input, and now", () => {
    const view = emptyView([triage]);
    const input = {
      type: "event" as const,
      event: { type: "issue.opened", source: "github", payload: { issue: "42" } },
    };
    const a = decide(view, input, NOW);
    const b = decide(view, input, NOW);
    assert.deepEqual(a, b);
    assert.equal(view.events.length, 0);
  });

  it("matches rules, extracts laneKey, and queues a run", () => {
    const store = new MemoryStore([triage]);
    const { facts, view } = store.commit(
      { type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "99" } } },
      NOW,
    );
    assert.equal(view.events.length, 1);
    assert.equal(view.runs.length, 1);
    assert.equal(view.runs[0].lane, "99");
    assert.equal(view.runs[0].status, "queued");
    assert.ok(facts.some((fact) => fact.type === "run.queued"));
  });

  it("skips disabled and paused rules", () => {
    const disabled = rule({ name: "off", enabled: false, trigger: { type: "event", source: "github" } });
    const paused = rule({ name: "held", paused: true, trigger: { type: "event", source: "github" } });
    const store = new MemoryStore([disabled, paused]);
    store.commit({ type: "event", event: { type: "x", source: "github" } }, NOW);
    assert.equal(store.view.runs.length, 0);
    assert.equal(store.view.events.length, 1);
  });

  it("dedupes events that share a dedupeKey", () => {
    const store = new MemoryStore([triage]);
    const event = { type: "issue.opened", source: "github", payload: { issue: "1" }, dedupeKey: "gh:1" };
    store.commit({ type: "event", event }, NOW);
    store.commit({ type: "event", event }, NOW + 1);
    assert.equal(store.view.events.length, 1);
    assert.equal(store.view.runs.length, 1);
  });

  it("serializes runs on the same lane and respects claim capacity", () => {
    const store = new MemoryStore([triage]);
    store.commit({ type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "7" } } }, NOW);
    store.commit({ type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "7" } } }, NOW + 1);
    assert.equal(store.view.runs.length, 1);
    assert.equal(store.view.runs[0].eventIds.length, 2);

    const first = store.commit({ type: "claim", worker: "w1", capacity: 1, running: [] }, NOW + 2);
    assert.equal(first.facts[0]?.type, "run.claimed");
    store.commit(
      { type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "7" }, dedupeKey: "later" } },
      NOW + 3,
    );
    assert.equal(store.view.runs.length, 2);
    const second = store.commit({ type: "claim", worker: "w2", capacity: 2, running: [] }, NOW + 4);
    assert.equal(second.facts.length, 0, "same lane must stay serial while the first run is claimed");
    store.commit({ type: "result", runId: store.view.runs[0].id, outcome: "done" }, NOW + 5);
    const claimed = store.commit({ type: "claim", worker: "w2", capacity: 2, running: [] }, NOW + 6);
    assert.equal(claimed.facts[0]?.type, "run.claimed");
  });

  it("records hop-limit events without dispatching and creates a notice card", () => {
    const store = new MemoryStore([triage]);
    store.commit(
      { type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "8" }, hops: 9 } },
      NOW,
    );
    assert.equal(store.view.events[0].circuitBroken, true);
    assert.equal(store.view.runs.length, 0);
    assert.equal(store.view.cards.length, 1);
    assert.equal(store.view.cards[0].kind, "notice");
  });

  it("emitted receipt events increment hops and trip the breaker above 8", () => {
    const store = new MemoryStore([
      rule({ name: "loop", trigger: { type: "event" }, channels: ["web"] }),
    ]);
    store.commit({ type: "event", event: { type: "ping", source: "custom", hops: 8 } }, NOW);
    const runId = store.view.runs[0].id;
    store.commit({ type: "claim", worker: "w", capacity: 1, running: [] }, NOW + 1);
    store.commit({ type: "started", runId }, NOW + 2);
    store.commit(
      {
        type: "result",
        runId,
        outcome: "done",
        receipt: { events: [{ type: "ping", payload: { n: 1 } }] },
      },
      NOW + 3,
    );
    const child = store.view.events[1];
    assert.equal(child.hops, 9);
    assert.equal(child.circuitBroken, true);
    assert.ok(store.view.cards.some((card) => card.kind === "notice"));
  });

  it("supports ask suspend and answer resume on the same session", () => {
    const store = new MemoryStore([triage]);
    store.commit(
      { type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "3" } } },
      NOW,
    );
    const origin = store.view.runs[0];
    store.commit({ type: "claim", worker: "w", capacity: 1, running: [] }, NOW + 1);
    store.commit(
      {
        type: "result",
        runId: origin.id,
        outcome: "done",
        sessionId: "sess-1",
        receipt: { ask: { title: "Approve?", body: "Merge this?", options: ["yes", "no"] } },
      },
      NOW + 2,
    );
    const card = store.view.cards[0];
    assert.equal(card.status, "open");
    assert.equal(card.kind, "ask");
    assert.equal(store.view.deliveries.length, 2);
    assert.equal(store.view.runs[0].status, "done");

    store.commit({ type: "answer", cardId: card.id, choice: "yes", text: "ship it", responder: "kai" }, NOW + 3);
    assert.equal(store.view.cards[0].status, "decided");
    const resumed = store.view.runs[1];
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.sessionId, "sess-1");
    assert.equal(resumed.context?.answer?.choice, "yes");
    store.commit({ type: "claim", worker: "w", capacity: 1, running: [] }, NOW + 4);
    const job = buildJob(store.view, store.view.runs[1]);
    assert.ok(job);
    assert.equal(job?.sessionId, "sess-1");
    assert.equal(job?.context.answer?.cardId, card.id);
  });

  it("applies notice, resolve, later, cancel, and timer ticks", () => {
    const store = new MemoryStore([triage]);
    store.commit(
      { type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "4" } } },
      NOW,
    );
    const runId = store.view.runs[0].id;
    store.commit({ type: "claim", worker: "w", capacity: 1, running: [] }, NOW + 1);
    store.commit(
      {
        type: "result",
        runId,
        outcome: "done",
        receipt: {
          notice: { title: "FYI", body: "looked fine" },
          later: { delaySeconds: 10, reason: "recheck" },
        },
      },
      NOW + 2,
    );
    const notice = store.view.cards[0];
    assert.equal(notice.kind, "notice");
    store.commit({ type: "resolve", cardId: notice.id, summary: "ack" }, NOW + 3);
    assert.equal(store.view.cards[0].status, "closed");
    assert.equal(store.view.timers[0].fired, false);

    store.commit({ type: "tick" }, NOW + 2 + 10_000);
    assert.equal(store.view.timers[0].fired, true);
    assert.ok(store.view.events.some((event) => event.type === "timer"));
    assert.ok(store.view.runs.length >= 2);

    store.commit({ type: "manual", ruleName: "triage", payload: { why: "owner" } }, NOW + 20_000);
    const manual = store.view.runs.at(-1)!;
    store.commit({ type: "claim", worker: "w", capacity: 4, running: [] }, NOW + 20_001);
    store.commit({ type: "cancel", runId: manual.id }, NOW + 20_002);
    assert.equal(store.view.runs.find((run) => run.id === manual.id)?.status, "cancelled");
  });

  it("rebuilds the same view from the fact log", () => {
    const store = new MemoryStore([triage]);
    store.commit({ type: "event", event: { type: "issue.opened", source: "github", payload: { issue: "5" } } }, NOW);
    store.commit({ type: "claim", worker: "w", capacity: 1, running: [] }, NOW + 1);
    const snapshot = structuredClone(store.view);
    store.rebuild();
    assert.deepEqual(store.view, snapshot);
    assert.deepEqual(evolve(emptyView([triage]), store.log), snapshot);
  });

  it("throws when answering a missing card", () => {
    const store = new MemoryStore([triage]);
    assert.throws(() => store.commit({ type: "answer", cardId: "missing", choice: "x" }, NOW), DecisionError);
  });
});
