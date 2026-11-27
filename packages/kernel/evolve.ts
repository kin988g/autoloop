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
  private positions?: Map<string, number>;

  constructor(values: T[], changes?: Map<string, T>, indexed = false) {
    this.values = values;
    this.changes = changes;
    if (indexed) this.positions = new Map(values.map((row, index) => [row.id, index]));
  }

  protected indexOf(id: string): number {
    if (this.positions) return this.positions.get(id) ?? -1;
    return this.values.findIndex(row => row.id === id);
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
    const index = this.indexOf(row.id);
    if (index < 0) this.positions?.set(row.id, this.values.length);
    this.write(index < 0 ? this.values.length : index, row);
  }

  patch(id: string, update: (row: T) => T): void {
    const index = this.indexOf(id);
    if (index < 0) return;
    const row = this.values[index];
    const updated = update(row);
    if (updated !== row) this.write(index, updated);
  }

  patchIds(ids: string[], update: (row: T) => T): void {
    if (this.positions || ids.length <= 1) {
      for (const id of new Set(ids)) this.patch(id, update);
    } else {
      const wanted = new Set(ids);
      this.matching(row => wanted.has(row.id), update);
    }
  }

  matching(test: (row: T) => boolean, update: (row: T) => T): void {
    this.values.forEach((row, index) => {
      if (test(row)) this.write(index, update(row));
    });
  }
}

// A receipt addresses deliveries by (card, channel), which can match multiple IDs.
class DeliveryRows extends Rows<DeliveryRecord> {
  private groups?: Map<string, Set<string>>;

  constructor(values: DeliveryRecord[], changes?: Map<string, DeliveryRecord>, indexed = false) {
    super(values, changes, indexed);
    // Indexed batches always begin with an empty replay view.
    if (indexed) this.groups = new Map();
  }

  private key(cardId: string, channel: string): string {
    return JSON.stringify([cardId, channel]);
  }

  override put(row: DeliveryRecord): void {
    if (this.groups) {
      const old = this.values[this.indexOf(row.id)];
      if (old) this.groups.get(this.key(old.cardId, old.channel))?.delete(row.id);
      const key = this.key(row.cardId, row.channel);
      const ids = this.groups.get(key) ?? new Set<string>();
      ids.add(row.id);
      this.groups.set(key, ids);
    }
    super.put(row);
  }

  patchChannel(cardId: string, channel: string, update: (row: DeliveryRecord) => DeliveryRecord): void {
    if (this.groups) {
      for (const id of this.groups.get(this.key(cardId, channel)) ?? []) this.patch(id, update);
    } else {
      this.matching(row => row.cardId === cardId && row.channel === channel, update);
    }
  }
}

function projectionRows(view: HubView, changes?: ProjectionChanges, indexed = false) {
  return {
    events: new Rows(view.events, changes?.events, indexed),
    runs: new Rows(view.runs, changes?.runs, indexed),
    cards: new Rows(view.cards, changes?.cards, indexed),
    timers: new Rows(view.timers, changes?.timers, indexed),
    deliveries: new DeliveryRows(view.deliveries, changes?.deliveries, indexed),
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
        rows.events.patchIds(fact.run.eventIds, event => ({ ...event, runId, routed: true }));
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
      rows.deliveries.patchChannel(
        fact.cardId, fact.channel,
        delivery => ({ ...delivery, status: "delivered", externalId: fact.externalId ?? delivery.externalId, updatedAt: fact.at }),
      );
      return;
    }
    case "delivery.failed": {
      rows.deliveries.patchChannel(
        fact.cardId, fact.channel,
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
  return reduceBatch(view, facts, projectionRows(view, changes), changes);
}

export function replay(rules: Rule[], facts: Iterable<Fact>): HubView {
  const view = emptyView(rules);
  return reduceBatch(view, facts, projectionRows(view, undefined, true));
}

function reduceBatch(view: HubView, facts: Iterable<Fact>, rows: ReturnType<typeof projectionRows>, changes?: ProjectionChanges): HubView {
  const next = { ...view, nextIds: { ...view.nextIds }, pauses: { ...view.pauses } };
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
