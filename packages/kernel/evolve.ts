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

export class ProjectionChanges {
  events = new Map<string, EventRecord>();
  runs = new Map<string, RunRecord>();
  cards = new Map<string, Card>();
  deliveries = new Map<string, DeliveryRecord>();
  timers = new Map<string, TimerRecord>();
  pauses = new Set<string>();
}

// Each batch owns its new arrays after the first write; published views stay immutable.
class Rows<T extends { id: string }> {
  values: T[];
  private owned = false;
  private changes?: Map<string, T>;

  constructor(values: T[], changes?: Map<string, T>) {
    this.values = values;
    this.changes = changes;
  }

  private write(index: number, row: T): void {
    if (!this.owned) {
      this.values = this.values.slice();
      this.owned = true;
    }
    this.values[index] = row;
    this.changes?.set(row.id, row);
  }

  put(row: T): void {
    const index = this.values.findIndex(item => item.id === row.id);
    this.write(index < 0 ? this.values.length : index, row);
  }

  patch(id: string, update: (row: T) => T): void {
    const index = this.values.findIndex(item => item.id === id);
    if (index < 0) return;
    const row = this.values[index];
    const updated = update(row);
    if (updated !== row) this.write(index, updated);
  }

  matching(test: (row: T) => boolean, update: (row: T) => T): void {
    this.values.forEach((row, index) => {
      if (test(row)) this.write(index, update(row));
    });
  }
}

function projectionRows(view: HubView, changes?: ProjectionChanges) {
  return {
    events: new Rows(view.events, changes?.events),
    runs: new Rows(view.runs, changes?.runs),
    cards: new Rows(view.cards, changes?.cards),
    timers: new Rows(view.timers, changes?.timers),
    deliveries: new Rows(view.deliveries, changes?.deliveries),
  };
}

function projectFact(next: HubView, rows: ReturnType<typeof projectionRows>, fact: Fact, changes?: ProjectionChanges): void {
  next.seq++;
  switch (fact.type) {
    case "event.recorded": {
      rows.events.put({ ...fact.event });
      bump(next.nextIds, "event", fact.event.id);
      return;
    }
    case "run.queued": {
      rows.runs.put({ ...fact.run, eventIds: [...fact.run.eventIds] });
      bump(next.nextIds, "run", fact.run.id);
      if (fact.run.eventIds.length) {
        const runId = fact.run.id;
        const ids = new Set(fact.run.eventIds);
        rows.events.matching(event => ids.has(event.id), event => ({ ...event, runId, routed: true }));
      }
      return;
    }
    case "run.event-attached": {
      rows.runs.patch(fact.runId, (run) =>
        run.eventIds.includes(fact.eventId) ? run : { ...run, eventIds: [...run.eventIds, fact.eventId], updatedAt: fact.at },
      );
      rows.events.patch(fact.eventId, event => ({ ...event, runId: fact.runId, routed: true }));
      return;
    }
    case "run.claimed": {
      rows.runs.patch(fact.runId, (run) => ({
        ...run,
        status: "claimed",
        worker: fact.worker,
        attempt: fact.attempt,
        runToken: fact.runToken,
        claimedAt: fact.at,
        updatedAt: fact.at,
      }));
      return;
    }
    case "run.started": {
      rows.runs.patch(fact.runId, (run) => ({
        ...run,
        status: "running",
        startedAt: fact.at,
        updatedAt: fact.at,
      }));
      return;
    }
    case "run.result": {
      rows.runs.patch(fact.runId, (run) => ({
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
      return;
    }
    case "run.cancelled": {
      rows.runs.patch(fact.runId, (run) => ({
        ...run,
        status: "cancelled",
        outcome: "cancelled",
        finishedAt: fact.at,
        updatedAt: fact.at,
      }));
      return;
    }
    case "card.created": {
      rows.cards.put({ ...fact.card });
      bump(next.nextIds, "card", fact.card.id);
      return;
    }
    case "card.answered": {
      rows.cards.patch(fact.cardId, (card) => ({
        ...card,
        status: "decided",
        answer: fact.answer,
        updatedAt: fact.at,
      }));
      return;
    }
    case "card.resolved": {
      rows.cards.patch(fact.cardId, (card) => ({
        ...card,
        status: "closed",
        updatedAt: fact.at,
      }));
      return;
    }
    case "card.done": {
      rows.cards.patch(fact.cardId, (card) => ({
        ...card,
        status: "done",
        updatedAt: fact.at,
      }));
      return;
    }
    case "delivery.queued": {
      rows.deliveries.put({ ...fact.delivery });
      bump(next.nextIds, "delivery", fact.delivery.id);
      return;
    }
    case "delivery.leased": {
      rows.deliveries.patch(fact.deliveryId, (delivery) => ({
        ...delivery,
        status: "leased",
        updatedAt: fact.at,
      }));
      return;
    }
    case "delivery.delivered": {
      rows.deliveries.matching(
        delivery => delivery.cardId === fact.cardId && delivery.channel === fact.channel,
        delivery => ({ ...delivery, status: "delivered", externalId: fact.externalId ?? delivery.externalId, updatedAt: fact.at }),
      );
      return;
    }
    case "delivery.failed": {
      rows.deliveries.matching(
        delivery => delivery.cardId === fact.cardId && delivery.channel === fact.channel,
        delivery => ({ ...delivery, status: "failed", error: fact.error, updatedAt: fact.at }),
      );
      return;
    }
    case "timer.created": {
      rows.timers.put({ ...fact.timer });
      bump(next.nextIds, "timer", fact.timer.id);
      return;
    }
    case "timer.fired": {
      rows.timers.patch(fact.timerId, (timer) => ({ ...timer, fired: true }));
      return;
    }
    case "rule.paused": {
      changes?.pauses.add(fact.ruleName);
      next.pauses[fact.ruleName] = fact.at;
      return;
    }
    case "rule.resumed": {
      changes?.pauses.add(fact.ruleName);
      delete next.pauses[fact.ruleName];
      return;
    }
    case "rules.replaced": {
      next.rules = fact.rules.map((rule) => ({ ...rule }));
      return;
    }
    default: {
      return;
    }
  }
}

export function applyFact(view: HubView, fact: Fact): HubView {
  return evolve(view, [fact]);
}

export function evolve(view: HubView, facts: readonly Fact[], changes?: ProjectionChanges): HubView {
  if (!facts.length) return view;
  const next = { ...view, nextIds: { ...view.nextIds }, pauses: { ...view.pauses } };
  const rows = projectionRows(view, changes);
  for (const fact of facts) projectFact(next, rows, fact, changes);
  return { ...next, events: rows.events.values, runs: rows.runs.values, cards: rows.cards.values,
    deliveries: rows.deliveries.values, timers: rows.timers.values };
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
