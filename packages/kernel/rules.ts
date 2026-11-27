import type { EventRecord, Rule } from "../protocol/types.ts";

export function isRulePaused(rule: Rule, pauses: Record<string, number>): boolean {
  return rule.paused === true || pauses[rule.name] !== undefined;
}

export function matchRules(
  rules: readonly Rule[],
  pauses: Record<string, number>,
  event: { type: string; source: string },
): Rule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || isRulePaused(rule, pauses)) return false;
    const trigger = rule.trigger;
    if (trigger.type !== "event" && trigger.type !== "webhook") return false;
    if (trigger.source && trigger.source !== event.source) return false;
    if (trigger.eventType && trigger.eventType !== event.type) return false;
    return true;
  });
}

export function resolveLane(rule: Rule, event: { lane?: string; payload?: unknown }): string {
  if (event.lane) return event.lane;
  if (rule.laneKey && event.payload && typeof event.payload === "object" && event.payload !== null) {
    const value = (event.payload as Record<string, unknown>)[rule.laneKey];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "default";
}

export function ruleByName(rules: readonly Rule[], name: string): Rule | undefined {
  return rules.find((rule) => rule.name === name);
}

export function findActiveRun(runs: readonly { ruleName: string; lane: string; status: string }[], ruleName: string, lane: string) {
  return runs.find(
    (run) => ruleName === run.ruleName && run.lane === lane && (run.status === "claimed" || run.status === "running"),
  );
}

export function findQueuedRun(runs: readonly { ruleName: string; lane: string; status: string }[], ruleName: string, lane: string) {
  return runs.find((run) => ruleName === run.ruleName && run.lane === lane && run.status === "queued");
}

export type IngestLike = Pick<EventRecord, "type" | "source"> & { lane?: string; payload?: unknown };
