import type { Fact, HubView, Rule } from "../protocol/types.ts";
import { decide, type DecisionInput } from "./decide.ts";
import { emptyView, evolve } from "./evolve.ts";

export type CommitResult = {
  facts: Fact[];
  view: HubView;
};

export interface FactStore {
  readonly view: HubView;
  readonly log: readonly Fact[];
  commit(input: DecisionInput, now: number): CommitResult;
  replaceRules(rules: Rule[], now: number): CommitResult;
  rebuild(): HubView;
}

export class MemoryStore implements FactStore {
  view: HubView;
  log: Fact[];

  constructor(rules: Rule[] = [], log: Fact[] = []) {
    this.log = log.slice();
    this.view = log.length ? evolve(emptyView(rules), log) : emptyView(rules);
    if (log.length && rules.length) this.view = { ...this.view, rules: rules.map((rule) => ({ ...rule })) };
  }

  commit(input: DecisionInput, now: number): CommitResult {
    const facts = decide(this.view, input, now);
    if (!facts.length) return { facts, view: this.view };
    this.log.push(...facts);
    this.view = evolve(this.view, facts);
    return { facts, view: this.view };
  }

  replaceRules(rules: Rule[], now: number): CommitResult {
    return this.commit({ type: "rules", rules }, now);
  }

  rebuild(): HubView {
    const rules = this.view.rules;
    this.view = evolve(emptyView(rules), this.log);
    return this.view;
  }
}

export function reduce(rules: Rule[], facts: readonly Fact[]): HubView {
  return evolve(emptyView(rules), facts);
}
