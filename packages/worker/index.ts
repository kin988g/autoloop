export { HubClient, HubError } from "./client.ts";
export type { HubClientOptions, PollWorkOptions } from "./client.ts";
export {
  MAX_REPAIR_ATTEMPTS,
  buildRepairPrompt,
  extractReceipt,
  parseReceipt,
  receiptNeedsRepair,
  runWithReceiptRepair,
  validateReceipt,
} from "./contract.ts";
export type { AgentAttempt, ReceiptExtract, RunOutcome, RunResultPayload } from "./contract.ts";
export { writeContextFile, buildAgentPrompt } from "./prompt.ts";
export type { ContextFilePayload } from "./prompt.ts";
export { executeJob, quoteWindowsCmdArg, resolveWindowsSpawn, spawnAgentAttempt } from "./runner.ts";
export type { ExecuteJobOptions, ResolvedSpawn } from "./runner.ts";
export { createWorker, Worker } from "./worker.ts";
export type { WorkerOptions } from "./worker.ts";
export { main, parseArgs, usage } from "./run.ts";
export type { CliOptions } from "./run.ts";
