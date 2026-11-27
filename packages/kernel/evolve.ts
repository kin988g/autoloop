import type {
  Card,
  DeliveryRecord,
  EventRecord,
  Fact,
  HubView,
  IdCounters,
  Rule,
  RunRecord,
  TimerRecord,
} from "../protocol/types.ts";

export function emptyIds(): IdCounters {
  return { event: 1, run: 1, card: 1, delivery: 1, timer: 1 };
}

export function emptyView(rules: Rule[] = []): HubView {
  return {
    seq: 0,
    nextIds: emptyIds(),
    rules: rules.map((rule) => ({ ...rule })),
    events: [],
    runs: [],
    cards: [],
    deliveries: [],
    timers: [],
    pauses: {},
  };
}

function bump(ids: IdCounters, kind: keyof IdCounters, rawId: string): void {
  const match = rawId.match(/(\d+)$/);
  if (!match) return;
  const value = Number(match[1]) + 1;
  if (value > ids[kind]) ids[kind] = value;
}

function replaceById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((row) => row.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function patchById<T extends { id: string }>(list: T[], id: string, patch: (row: T) => T): T[] {
  return list.map((row) => (row.id === id ? patch(row) : row));
}

export function applyFact(view: HubView, fact: Fact): HubView {
  const next: HubView = {
    ...view,
    nextIds: { ...view.nextIds },
    pauses: { ...view.pauses },
    rules: view.rules,
    events: view.events,
    runs: view.runs,
    cards: view.cards,
    deliveries: view.deliveries,
    timers: view.timers,
    seq: view.seq + 1,
  };
  switch (fact.type) {
    case "event.recorded": {
      next.events = replaceById(view.events, { ...fact.event });
      bump(next.nextIds, "event", fact.event.id);
      return next;
    }
    case "run.queued": {
      next.runs = replaceById(view.runs, { ...fact.run, eventIds: [...fact.run.eventIds] });
      bump(next.nextIds, "run", fact.run.id);
      if (fact.run.eventIds.length) {
        const runId = fact.run.id;
        const ids = new Set(fact.run.eventIds);
        next.events = view.events.map((event) => (ids.has(event.id) ? { ...event, runId, routed: true } : event));
      }
      return next;
    }
    case "run.event-attached": {
      next.runs = patchById(view.runs, fact.runId, (run) =>
        run.eventIds.includes(fact.eventId) ? run : { ...run, eventIds: [...run.eventIds, fact.eventId], updatedAt: fact.at },
      );
      next.events = view.events.map((event) =>
        event.id === fact.eventId ? { ...event, runId: fact.runId, routed: true } : event,
      );
      return next;
    }
    case "run.claimed": {
      next.runs = patchById(view.runs, fact.runId, (run) => ({
        ...run,
        status: "claimed",
        worker: fact.worker,
        attempt: fact.attempt,
        runToken: fact.runToken,
        claimedAt: fact.at,
        updatedAt: fact.at,
      }));
      return next;
    }
    case "run.started": {
      next.runs = patchById(view.runs, fact.runId, (run) => ({
        ...run,
        status: "running",
        startedAt: fact.at,
        updatedAt: fact.at,
      }));
      return next;
    }
    case "run.result": {
      next.runs = patchById(view.runs, fact.runId, (run) => ({
        ...run,
        status: fact.outcome,
        outcome: fact.outcome,
        sessionId: fact.sessionId ?? run.sessionId,
        receipt: fact.receipt ?? run.receipt,
        error: fact.error,
        usage: fact.usage ?? run.usage,
        finishedAt: fact.at,
        updatedAt: fact.at,
      }));
      return next;
    }
    case "run.cancelled": {
      next.runs = patchById(view.runs, fact.runId, (run) => ({
        ...run,
        status: "cancelled",
        outcome: "cancelled",
        finishedAt: fact.at,
        updatedAt: fact.at,
      }));
      return next;
    }
    case "card.created": {
      next.cards = replaceById(view.cards, { ...fact.card });
      bump(next.nextIds, "card", fact.card.id);
      return next;
    }
    case "card.answered": {
      next.cards = patchById(view.cards, fact.cardId, (card) => ({
        ...card,
        status: "decided",
        answer: fact.answer,
        updatedAt: fact.at,
      }));
      return next;
    }
    case "card.resolved": {
      next.cards = patchById(view.cards, fact.cardId, (card) => ({
        ...card,
        status: "closed",
        updatedAt: fact.at,
      }));
      return next;
    }
    case "card.done": {
      next.cards = patchById(view.cards, fact.cardId, (card) => ({
        ...card,
        status: "done",
        updatedAt: fact.at,
      }));
      return next;
    }
    case "delivery.queued": {
      next.deliveries = replaceById(view.deliveries, { ...fact.delivery });
      bump(next.nextIds, "delivery", fact.delivery.id);
      return next;
    }
    case "delivery.leased": {
      next.deliveries = patchById(view.deliveries, fact.deliveryId, (delivery) => ({
        ...delivery,
        status: "leased",
        updatedAt: fact.at,
      }));
      return next;
    }
    case "delivery.delivered": {
      next.deliveries = view.deliveries.map((delivery) =>
        delivery.cardId === fact.cardId && delivery.channel === fact.channel
          ? { ...delivery, status: "delivered", externalId: fact.externalId ?? delivery.externalId, updatedAt: fact.at }
          : delivery,
      );
      return next;
    }
    case "delivery.failed": {
      next.deliveries = view.deliveries.map((delivery) =>
        delivery.cardId === fact.cardId && delivery.channel === fact.channel
          ? { ...delivery, status: "failed", error: fact.error, updatedAt: fact.at }
          : delivery,
      );
      return next;
    }
    case "timer.created": {
      next.timers = replaceById(view.timers, { ...fact.timer });
      bump(next.nextIds, "timer", fact.timer.id);
      return next;
    }
    case "timer.fired": {
      next.timers = patchById(view.timers, fact.timerId, (timer) => ({ ...timer, fired: true }));
      return next;
    }
    case "rule.paused": {
      next.pauses[fact.ruleName] = fact.at;
      return next;
    }
    case "rule.resumed": {
      delete next.pauses[fact.ruleName];
      return next;
    }
    case "rules.replaced": {
      next.rules = fact.rules.map((rule) => ({ ...rule }));
      return next;
    }
    default: {
      return next;
    }
  }
}

export function evolve(view: HubView, facts: readonly Fact[]): HubView {
  let current = view;
  for (const fact of facts) current = applyFact(current, fact);
  return current;
}

export function findEvent(view: HubView, id: string): EventRecord | undefined {
  return view.events.find((event) => event.id === id);
}

export function findRun(view: HubView, id: string): RunRecord | undefined {
  return view.runs.find((run) => run.id === id);
}

export function findCard(view: HubView, id: string): Card | undefined {
  return view.cards.find((card) => card.id === id);
}

export function findDelivery(view: HubView, cardId: string, channel: string): DeliveryRecord | undefined {
  return view.deliveries.find((delivery) => delivery.cardId === cardId && delivery.channel === channel);
}

export function findTimer(view: HubView, id: string): TimerRecord | undefined {
  return view.timers.find((timer) => timer.id === id);
}
