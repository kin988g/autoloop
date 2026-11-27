export type {
  SourceEvent,
  SourceVerifyResult,
  SourceAdapter,
  CronRuleLike,
} from "./types.ts";
export {
  getHeader,
  isRecord,
  parseJsonObject,
  timingSafeStringEqual,
} from "./types.ts";

export type { ParsedCron, CronSchedulerOptions, ZonedParts } from "./cron-runner.ts";
export {
  parseCron,
  matchesCron,
  matchesParsedCron,
  nextCronTime,
  getZonedParts,
  formatZonedMinute,
  CronScheduler,
} from "./cron-runner.ts";

export { githubSource } from "./github.ts";
export { gitlabSource } from "./gitlab.ts";
export {
  createWebhookSource,
  createGenericSource,
  webhookSource,
  genericSource,
} from "./generic.ts";

import type { SourceAdapter } from "./types.ts";
import { githubSource } from "./github.ts";
import { gitlabSource } from "./gitlab.ts";
import { genericSource, webhookSource } from "./generic.ts";

export const sourceAdapters: Record<string, SourceAdapter> = {
  github: githubSource,
  gitlab: gitlabSource,
  custom: webhookSource,
  webhook: webhookSource,
  generic: genericSource,
};

export function getSourceAdapter(name: string): SourceAdapter | undefined {
  return sourceAdapters[name] ?? sourceAdapters[name.toLowerCase()];
}
