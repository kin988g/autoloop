import { isDeepStrictEqual } from "node:util";
import type {
  Card,
  DeliveryRecord,
  EventRecord,
  Fact,
  HubView,
  Job,
  Receipt,
  Rule,
  RunRecord,
  TimerRecord,
} from "../protocol/types.ts";
import { MAX_HOPS } from "../protocol/types.ts";
import { findCard, findDelivery, findEvent, findRun } from "./evolve.ts";
import { findQueuedRun, isRulePaused, matchRules, resolveLane, ruleByName } from "./rules.ts";

export type EventInput = {
  type: string;
  source: string;
  lane?: string;
  payload?: unknown;
  dedupeKey?: string;
  hops?: number;
};

export type DecisionInput =
  | { type: "event"; event: EventInput }
  | { type: "claim"; worker: string; capacity: number; running: string[] }
  | { type: "started"; runId: string; runToken?: string }
  | {
      type: "result";
      runId: string;
      runToken?: string;
      outcome: "done" | "nothing" | "failed" | "cancelled";
      sessionId?: string;
      receipt?: Receipt;
      error?: string;
      usage?: Record<string, number>;
    }
  | { type: "cancel"; runId: string }
  | { type: "delivered"; cardId: string; channel: string; externalId?: string }
  | { type: "failed"; cardId: string; channel: string; error: string }
  | { type: "answer"; cardId: string; choice?: string; text?: string; responder?: string }
  | { type: "resolve"; cardId: string; summary?: string }
  | { type: "lease"; channel: string }
  | { type: "pause"; ruleName: string }
  | { type: "resume"; ruleName: string }
  | { type: "manual"; ruleName: string; payload?: unknown }
  | { type: "cron"; ruleName: string; payload?: unknown }
  | { type: "tick" }
  | { type: "rules"; rules: Rule[] };

export class DecisionError extends Error {
  readonly code: "not_found" | "conflict" | "invalid";

  constructor(code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
  }
}

type Alloc = { event: number; run: number; card: number; delivery: number; timer: number };

function allocFrom(view: HubView): Alloc {
  return { ...view.nextIds };
}

function take(alloc: Alloc, kind: keyof Alloc, prefix: string): string {
  const id = `${prefix}${alloc[kind]}`;
  alloc[kind] += 1;
  return id;
}

function deferred(view: HubView, facts: Fact[]): HubView {
  // Lightweight overlay so a single decision can see its own facts without writing the view.
  let events = view.events;
  let runs = view.runs;
  let cards = view.cards;
  let deliveries = view.deliveries;
  let timers = view.timers;
  let pauses = view.pauses;
  let rules = view.rules;
  const apply = (list: { id: string }[], item: { id: string }) => {
    const index = list.findIndex((row) => row.id === item.id);
    if (index === -1) return [...list, item];
    const next = list.slice();
    next[index] = item;
    return next;
  };
  for (const fact of facts) {
    switch (fact.type) {
      case "event.recorded":
        events = apply(events, fact.event) as typeof events;
        break;
      case "run.queued":
        runs = apply(runs, fact.run) as typeof runs;
        break;
      case "run.event-attached":
        runs = runs.map((run) =>
          run.id === fact.runId && !run.eventIds.includes(fact.eventId)
            ? { ...run, eventIds: [...run.eventIds, fact.eventId], updatedAt: fact.at }
            : run,
        );
        events = events.map((event) =>
          event.id === fact.eventId ? { ...event, runId: fact.runId, routed: true } : event,
        );
        break;
      case "card.created":
        cards = apply(cards, fact.card) as typeof cards;
        break;
      case "delivery.queued":
        deliveries = apply(deliveries, fact.delivery) as typeof deliveries;
        break;
      case "timer.created":
        timers = apply(timers, fact.timer) as typeof timers;
        break;
      case "timer.fired":
        timers = timers.map((timer) => (timer.id === fact.timerId ? { ...timer, fired: true } : timer));
        break;
      case "rule.paused":
        pauses = { ...pauses, [fact.ruleName]: fact.at };
        break;
      case "rule.resumed": {
        pauses = { ...pauses };
        delete pauses[fact.ruleName];
        break;
      }
      case "rules.replaced":
        rules = fact.rules;
        break;
      default:
        break;
    }
  }
  return { ...view, events, runs, cards, deliveries, timers, pauses, rules };
}

function hopsOf(view: HubView, run: RunRecord): number {
  const hops = run.eventIds
    .map((id) => findEvent(view, id)?.hops)
    .filter((value): value is number => value !== undefined);
  return hops.length ? Math.max(run.hops, ...hops) : run.hops;
}

function queueOrAttach(
  view: HubView,
  facts: Fact[],
  alloc: Alloc,
  now: number,
  rule: Rule,
  event: EventRecord,
  sessionId?: string,
  context?: Job["context"],
): void {
  const current = deferred(view, facts);
  const queued = findQueuedRun(current.runs, rule.name, event.lane) as RunRecord | undefined;
  if (queued) {
    facts.push({ type: "run.event-attached", at: now, runId: queued.id, eventId: event.id });
    return;
  }
  const run: RunRecord = {
    id: take(alloc, "run", "run_"),
    ruleName: rule.name,
    lane: event.lane,
    status: "queued",
    attempt: 0,
    eventIds: [event.id],
    hops: event.hops,
    sessionId,
    context,
    createdAt: now,
    updatedAt: now,
  };
  facts.push({ type: "run.queued", at: now, run });
}

function noticeCard(
  view: HubView,
  facts: Fact[],
  alloc: Alloc,
  now: number,
  spec: {
    runId: string;
    ruleName: string;
    lane: string;
    kind: "ask" | "notice";
    title: string;
    body: string;
    options?: string[];
    channels: string[];
  },
): string {
  const card: Card = {
    id: take(alloc, "card", "card_"),
    runId: spec.runId,
    ruleName: spec.ruleName,
    lane: spec.lane,
    kind: spec.kind,
    status: "open",
    title: spec.title,
    body: spec.body,
    options: spec.options,
    createdAt: now,
    updatedAt: now,
  };
  facts.push({ type: "card.created", at: now, card });
  for (const channel of spec.channels) {
    const delivery: DeliveryRecord = {
      id: take(alloc, "delivery", "del_"),
      cardId: card.id,
      channel,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    facts.push({ type: "delivery.queued", at: now, delivery });
  }
  return card.id;
}

function recordAndDispatch(
  view: HubView,
  facts: Fact[],
  alloc: Alloc,
  now: number,
  input: EventInput,
  onlyRule?: Rule,
): EventRecord {
  const hops = input.hops ?? 0;
  const circuitBroken = hops > MAX_HOPS;
  const event: EventRecord = {
    id: take(alloc, "event", "evt_"),
    type: input.type,
    source: input.source,
    lane: input.lane ?? "default",
    payload: input.payload ?? {},
    dedupeKey: input.dedupeKey,
    hops,
    routed: false,
    circuitBroken,
    createdAt: now,
  };

  const current = deferred(view, facts);
  const matches = onlyRule
    ? onlyRule.enabled && !isRulePaused(onlyRule, current.pauses)
      ? [onlyRule]
      : []
    : matchRules(current.rules, current.pauses, event);

  if (matches.length === 1) event.lane = resolveLane(matches[0], input);
  else if (input.lane) event.lane = input.lane;

  if (matches.length > 0) event.ruleName = matches[0].name;
  facts.push({ type: "event.recorded", at: now, event });

  if (circuitBroken) {
    const rule = matches[0];
    noticeCard(view, facts, alloc, now, {
      runId: "",
      ruleName: rule?.name ?? event.source,
      lane: rule ? resolveLane(rule, input) : event.lane,
      kind: "notice",
      title: "Hop limit exceeded",
      body: `Event ${event.id} (${event.type}) exceeded the hop limit of ${MAX_HOPS} and was not dispatched.`,
      channels: rule?.channels?.length ? rule.channels : ["web"],
    });
    return event;
  }

  for (const rule of matches) {
    const routed: EventRecord = { ...event, lane: resolveLane(rule, input), ruleName: rule.name };
    queueOrAttach(view, facts, alloc, now, rule, routed);
  }
  return event;
}

function ingestEvent(view: HubView, input: EventInput, now: number, facts: Fact[], alloc: Alloc, onlyRule?: Rule): void {
  if (input.dedupeKey) {
    const existing = deferred(view, facts).events.find((event) => event.dedupeKey === input.dedupeKey);
    if (existing) return;
  }
  recordAndDispatch(view, facts, alloc, now, input, onlyRule);
}

function claimWork(view: HubView, worker: string, capacity: number, running: string[], now: number): Fact[] {
  const held = new Set(running);
  const activeLanes = new Set<string>();
  for (const run of view.runs) {
    if (run.status === "claimed" || run.status === "running" || held.has(run.id)) {
      activeLanes.add(`${run.ruleName}::${run.lane}`);
    }
  }
  const free = Math.max(0, capacity - running.length);
  if (free < 1) return [];
  const candidates = view.runs
    .filter((run) => run.status === "queued")
    .filter((run) => (run.notBefore ?? 0) <= now)
    .filter((run) => !held.has(run.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const run of candidates) {
    const rule = ruleByName(view.rules, run.ruleName);
    if (!rule || !rule.enabled || isRulePaused(rule, view.pauses)) continue;
    if (activeLanes.has(`${run.ruleName}::${run.lane}`)) continue;
    const attempt = run.attempt + 1;
    const runToken = `rt_${run.id}_${attempt}`;
    return [{ type: "run.claimed", at: now, runId: run.id, worker, attempt, runToken }];
  }
  return [];
}

function applyReceipt(
  view: HubView,
  facts: Fact[],
  alloc: Alloc,
  now: number,
  run: RunRecord,
  receipt: Receipt | undefined,
): string | undefined {
  if (!receipt) return undefined;
  const current = deferred(view, facts);
  const rule = ruleByName(current.rules, run.ruleName);
  const channels = rule?.channels ?? [];
  const hops = hopsOf(current, run);
  let cardId: string | undefined;

  if (receipt.ask) {
    cardId = noticeCard(view, facts, alloc, now, {
      runId: run.id,
      ruleName: run.ruleName,
      lane: run.lane,
      kind: "ask",
      title: receipt.ask.title,
      body: receipt.ask.body,
      options: receipt.ask.options,
      channels,
    });
  }
  if (receipt.notice) {
    const id = noticeCard(view, facts, alloc, now, {
      runId: run.id,
      ruleName: run.ruleName,
      lane: run.lane,
      kind: "notice",
      title: receipt.notice.title,
      body: receipt.notice.body,
      channels,
    });
    cardId = cardId ?? id;
  }
  if (receipt.resolve) {
    const card = findCard(deferred(view, facts), receipt.resolve.cardId);
    if (card && card.status !== "closed" && card.status !== "done") {
      facts.push({ type: "card.resolved", at: now, cardId: card.id, summary: receipt.resolve.summary });
    }
  }
  if (receipt.later) {
    const timer: TimerRecord = {
      id: take(alloc, "timer", "tmr_"),
      ruleName: run.ruleName,
      lane: run.lane,
      runId: run.id,
      sessionId: run.sessionId,
      fireAt: now + Math.floor(receipt.later.delaySeconds * 1000),
      reason: receipt.later.reason,
      hops,
      eventIds: [...run.eventIds],
      fired: false,
      createdAt: now,
    };
    facts.push({ type: "timer.created", at: now, timer });
  }
  if (receipt.events) {
    for (const emitted of receipt.events) {
      ingestEvent(
        view,
        {
          type: emitted.type,
          source: run.ruleName,
          lane: emitted.lane ?? run.lane,
          payload: emitted.payload,
          hops: hops + 1,
        },
        now,
        facts,
        alloc,
      );
    }
  }
  return cardId;
}

function finishRun(view: HubView, input: Extract<DecisionInput, { type: "result" }>, now: number): Fact[] {
  const run = findRun(view, input.runId);
  if (!run) throw new DecisionError("not_found", `run not found: ${input.runId}`);
  if (input.runToken && run.runToken && input.runToken !== run.runToken) {
    throw new DecisionError("conflict", "run token mismatch");
  }
  if (run.status === "done" || run.status === "nothing" || run.status === "failed" || run.status === "cancelled") {
    const sameResult = run.outcome === input.outcome
      && (!input.sessionId || input.sessionId === run.sessionId)
      && input.error === run.error
      && isDeepStrictEqual(input.receipt, run.receipt)
      && isDeepStrictEqual(input.usage, run.usage);
    if (sameResult) return [];
    throw new DecisionError("conflict", `run ${input.runId} already finished`);
  }
  if (run.status !== "claimed" && run.status !== "running") {
    throw new DecisionError("conflict", `run ${input.runId} is ${run.status}`);
  }
  const facts: Fact[] = [
    {
      type: "run.result",
      at: now,
      runId: run.id,
      outcome: input.outcome,
      sessionId: input.sessionId ?? run.sessionId,
      receipt: input.receipt,
      error: input.error,
      usage: input.usage,
    },
  ];
  const alloc = allocFrom(view);
  const withSession: RunRecord = { ...run, sessionId: input.sessionId ?? run.sessionId };
  if (input.outcome === "done" || input.outcome === "nothing") {
    applyReceipt(view, facts, alloc, now, withSession, input.receipt);
  }
  if (input.outcome === "done" || input.outcome === "nothing" || input.outcome === "cancelled") {
    for (const card of view.cards) {
      if (card.runId === run.id && card.status === "decided") {
        facts.push({ type: "card.done", at: now, cardId: card.id });
      }
    }
  }
  return facts;
}

function answerCard(view: HubView, input: Extract<DecisionInput, { type: "answer" }>, now: number): Fact[] {
  const card = findCard(view, input.cardId);
  if (!card) throw new DecisionError("not_found", `card not found: ${input.cardId}`);
  if (card.kind !== "ask") throw new DecisionError("conflict", "only ask cards can be answered");
  if (card.status !== "open") throw new DecisionError("conflict", `card ${card.id} is ${card.status}`);
  const origin = findRun(view, card.runId);
  const rule = ruleByName(view.rules, card.ruleName);
  const answer = { choice: input.choice, text: input.text, responder: input.responder, answeredAt: now };
  const facts: Fact[] = [{ type: "card.answered", at: now, cardId: card.id, answer }];
  if (!rule || !rule.enabled || isRulePaused(rule, view.pauses)) return facts;
  const alloc = allocFrom(view);
  const eventIds = origin?.eventIds ?? [];
  const context: Job["context"] = {
    events: eventIds
      .map((id) => findEvent(view, id))
      .filter((event): event is EventRecord => event !== undefined)
      .map((event) => ({
        id: event.id,
        type: event.type,
        source: event.source,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    answer: { cardId: card.id, choice: input.choice, text: input.text, answeredAt: now },
    openCards: view.cards
      .filter((item) => item.ruleName === card.ruleName && item.lane === card.lane && item.status === "open" && item.id !== card.id)
      .map((item) => ({ id: item.id, title: item.title, body: item.body })),
  };
  const run: RunRecord = {
    id: take(alloc, "run", "run_"),
    ruleName: card.ruleName,
    lane: card.lane,
    status: "queued",
    attempt: 0,
    eventIds: [...eventIds],
    hops: origin?.hops ?? 0,
    sessionId: origin?.sessionId,
    context,
    createdAt: now,
    updatedAt: now,
  };
  facts.push({ type: "run.queued", at: now, run });
  return facts;
}

function fireTimers(view: HubView, now: number): Fact[] {
  const facts: Fact[] = [];
  const alloc = allocFrom(view);
  const due = view.timers.filter((timer) => !timer.fired && timer.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt || a.id.localeCompare(b.id));
  for (const timer of due) {
    facts.push({ type: "timer.fired", at: now, timerId: timer.id });
    const rule = ruleByName(deferred(view, facts).rules, timer.ruleName);
    ingestEvent(
      view,
      {
        type: "timer",
        source: "timer",
        lane: timer.lane,
        payload: { reason: timer.reason, timerId: timer.id, runId: timer.runId },
        hops: timer.hops,
      },
      now,
      facts,
      alloc,
      rule,
    );
  }
  return facts;
}

export function decide(view: HubView, input: DecisionInput, now: number): Fact[] {
  switch (input.type) {
    case "event": {
      const facts: Fact[] = [];
      ingestEvent(view, input.event, now, facts, allocFrom(view));
      return facts;
    }
    case "claim":
      return claimWork(view, input.worker, input.capacity, input.running, now);
    case "started": {
      const run = findRun(view, input.runId);
      if (!run) throw new DecisionError("not_found", `run not found: ${input.runId}`);
      if (run.status === "running") return [];
      if (run.status !== "claimed") throw new DecisionError("conflict", `run ${run.id} is ${run.status}`);
      if (input.runToken && run.runToken && input.runToken !== run.runToken) {
        throw new DecisionError("conflict", "run token mismatch");
      }
      return [{ type: "run.started", at: now, runId: run.id }];
    }
    case "result":
      return finishRun(view, input, now);
    case "cancel": {
      const run = findRun(view, input.runId);
      if (!run) throw new DecisionError("not_found", `run not found: ${input.runId}`);
      if (run.status === "cancelled") return [];
      if (run.status === "done" || run.status === "nothing" || run.status === "failed") {
        throw new DecisionError("conflict", `run ${run.id} already finished`);
      }
      return [{ type: "run.cancelled", at: now, runId: run.id }];
    }
    case "delivered": {
      const delivery = findDelivery(view, input.cardId, input.channel);
      if (!delivery) throw new DecisionError("not_found", "delivery not found");
      if (delivery.status === "delivered") return [];
      return [{ type: "delivery.delivered", at: now, cardId: input.cardId, channel: input.channel, externalId: input.externalId }];
    }
    case "failed": {
      const delivery = findDelivery(view, input.cardId, input.channel);
      if (!delivery) throw new DecisionError("not_found", "delivery not found");
      return [{ type: "delivery.failed", at: now, cardId: input.cardId, channel: input.channel, error: input.error }];
    }
    case "answer":
      return answerCard(view, input, now);
    case "resolve": {
      const card = findCard(view, input.cardId);
      if (!card) throw new DecisionError("not_found", `card not found: ${input.cardId}`);
      if (card.status === "closed" || card.status === "done") return [];
      return [{ type: "card.resolved", at: now, cardId: card.id, summary: input.summary }];
    }
    case "lease": {
      const pending = view.deliveries
        .filter((delivery) => delivery.channel === input.channel && delivery.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const delivery = pending[0];
      if (!delivery) return [];
      return [{ type: "delivery.leased", at: now, deliveryId: delivery.id, channel: input.channel }];
    }
    case "pause": {
      if (view.pauses[input.ruleName] !== undefined) return [];
      if (!ruleByName(view.rules, input.ruleName)) throw new DecisionError("not_found", `rule not found: ${input.ruleName}`);
      return [{ type: "rule.paused", at: now, ruleName: input.ruleName }];
    }
    case "resume": {
      if (view.pauses[input.ruleName] === undefined) return [];
      if (!ruleByName(view.rules, input.ruleName)) throw new DecisionError("not_found", `rule not found: ${input.ruleName}`);
      return [{ type: "rule.resumed", at: now, ruleName: input.ruleName }];
    }
    case "manual":
    case "cron": {
      const rule = ruleByName(view.rules, input.ruleName);
      if (!rule) throw new DecisionError("not_found", `rule not found: ${input.ruleName}`);
      const facts: Fact[] = [];
      ingestEvent(
        view,
        {
          type: input.type,
          source: input.type,
          lane: undefined,
          payload: input.payload ?? { rule: rule.name },
          hops: 0,
        },
        now,
        facts,
        allocFrom(view),
        rule,
      );
      return facts;
    }
    case "tick":
      return fireTimers(view, now);
    case "rules":
      return [{ type: "rules.replaced", at: now, rules: input.rules }];
    default:
      return [];
  }
}

export function buildJob(view: HubView, run: RunRecord): Job | undefined {
  const rule = ruleByName(view.rules, run.ruleName);
  if (!rule || !run.runToken) return undefined;
  const events = (run.context?.events ??
    run.eventIds
      .map((id) => findEvent(view, id))
      .filter((event): event is EventRecord => event !== undefined)
      .map((event) => ({
        id: event.id,
        type: event.type,
        source: event.source,
        payload: event.payload,
        createdAt: event.createdAt,
      })));
  const openCards = (
    run.context?.openCards ??
    view.cards
      .filter((card) => card.ruleName === run.ruleName && card.lane === run.lane && card.status === "open")
      .map((card) => ({ id: card.id, title: card.title, body: card.body }))
  );
  const job: Job = {
    runId: run.id,
    attempt: run.attempt,
    runToken: run.runToken,
    rule,
    lane: run.lane,
    context: {
      events,
      openCards,
    },
  };
  if (run.sessionId) job.sessionId = run.sessionId;
  if (run.context?.answer) job.context.answer = run.context.answer;
  return job;
}
