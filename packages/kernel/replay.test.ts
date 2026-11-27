import assert from "node:assert/strict";
import { it } from "node:test";
import type { DeliveryRecord, Fact } from "../protocol/types.ts";
import { applyFact, emptyView, replay } from "./evolve.ts";

it("matches incremental reduction for every prefix, including replaced IDs and delivery groups", () => {
  const delivery: DeliveryRecord = { id: "dl_2", cardId: "card_1", channel: "web", status: "pending", createdAt: 1, updatedAt: 1 };
  const event = { id: "evt_9", type: "manual", source: "manual", lane: "default", payload: {}, hops: 0, routed: false, circuitBroken: false, createdAt: 1 };
  const facts: Fact[] = [
    { type: "event.recorded", at: 1, event },
    { type: "event.recorded", at: 2, event: { ...event, id: "evt_1" } },
    { type: "event.recorded", at: 3, event: { ...event, payload: { edited: true } } },
    { type: "run.queued", at: 4, run: { id: "run_2", ruleName: "triage", lane: "default", status: "queued", attempt: 0,
      eventIds: ["evt_1", "evt_9", "evt_1", "missing"], hops: 0, createdAt: 4, updatedAt: 4 } },
    { type: "delivery.queued", at: 5, delivery },
    { type: "delivery.queued", at: 6, delivery: { ...delivery, id: "dl_1" } },
    { type: "delivery.failed", at: 7, cardId: "card_1", channel: "web", error: "offline" },
    { type: "delivery.queued", at: 8, delivery: { ...delivery, channel: "desktop" } },
    { type: "delivery.delivered", at: 9, cardId: "card_1", channel: "web", externalId: "remote" },
    { type: "rule.paused", at: 10, ruleName: "triage" },
    { type: "rule.resumed", at: 11, ruleName: "triage" },
  ];
  let expected = emptyView();
  for (const [i, fact] of facts.entries()) {
    expected = applyFact(expected, fact);
    assert.deepEqual(replay([], facts.slice(0, i + 1)), expected);
  }
  assert.deepEqual(expected.events.map(e => e.id), ["evt_9", "evt_1"]);
  assert.deepEqual(expected.deliveries.map(d => d.status), ["pending", "delivered"]);
});
