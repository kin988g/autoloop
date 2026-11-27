import {
  extractReceipt,
  parseReceipt,
  validateReceipt,
  type ReceiptExtract,
} from "../plugins/agents/receipt.ts";
import type { Job, Receipt } from "../plugins/agents/types.ts";

export { extractReceipt, parseReceipt, validateReceipt };
export type { ReceiptExtract };

/** Same-session repair retries after a malformed or schema-invalid receipt. */
export const MAX_REPAIR_ATTEMPTS = 2;

export type RunOutcome = "done" | "nothing" | "failed" | "cancelled";

export interface RunResultPayload {
  outcome: RunOutcome;
  sessionId?: string;
  receipt?: Receipt;
  error?: string;
  usage?: Record<string, number>;
}

export interface AgentAttempt {
  finalText: string;
  sessionId?: string;
  usage?: Record<string, number>;
  exitCode: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  error?: string;
}

export type AttemptRunner = (job: Job, prompt: string) => Promise<AgentAttempt>;

export function buildRepairPrompt(error: string): string {
  return [
    "The previous message's ```agent-autoloop receipt could not be parsed or failed schema validation.",
    `Parse/validation error: ${error}`,
    "Do not redo the work, and do not call tools unless required to format the receipt.",
    "Rewrite only the final message: include a single valid ```agent-autoloop fenced JSON block that conforms to the receipt schema (ask, notice, resolve, later, events).",
    "The closing ``` must be on its own line. Omit unused fields. The JSON must be valid.",
  ].join("\n");
}

export function receiptNeedsRepair(text: string): {
  needsRepair: boolean;
  receipt?: Receipt;
  error?: string;
} {
  const extracted = extractReceipt(text);
  if (extracted.error) {
    return { needsRepair: true, error: extracted.error, receipt: extracted.receipt };
  }
  return { needsRepair: false, receipt: extracted.receipt };
}

function withOptional<T extends object>(base: T, extra: object): T {
  return { ...base, ...extra };
}

/**
 * Runs the agent, then re-invokes it in the same session (up to `maxRepairs` times)
 * when the final message contains a malformed or schema-invalid receipt block.
 */
export async function runWithReceiptRepair(
  job: Job,
  initialPrompt: string,
  runOnce: AttemptRunner,
  options?: { maxRepairs?: number },
): Promise<RunResultPayload> {
  const maxRepairs = options?.maxRepairs ?? MAX_REPAIR_ATTEMPTS;
  let prompt = initialPrompt;
  let sessionId = job.sessionId;
  let usage: Record<string, number> | undefined;
  let lastError: string | undefined;

  for (let repair = 0; repair <= maxRepairs; repair++) {
    const currentJob: Job = sessionId ? { ...job, sessionId } : job;
    if (repair > 0) prompt = buildRepairPrompt(lastError ?? "invalid receipt");
    const attempt = await runOnce(currentJob, prompt);
    if (attempt.sessionId) sessionId = attempt.sessionId;
    if (attempt.usage) usage = attempt.usage;
    const extras = {
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
    };
    if (attempt.cancelled) {
      return withOptional({ outcome: "cancelled" as const }, extras);
    }
    if (attempt.timedOut) {
      return withOptional(
        { outcome: "failed" as const, error: attempt.error ?? "Timed out" },
        extras,
      );
    }
    if (attempt.exitCode !== 0 && attempt.exitCode !== null) {
      return withOptional(
        {
          outcome: "failed" as const,
          error: attempt.error ?? `Agent exited with code ${attempt.exitCode}`,
        },
        extras,
      );
    }
    if (attempt.error && !attempt.finalText.trim()) {
      return withOptional({ outcome: "failed" as const, error: attempt.error }, extras);
    }

    const verdict = receiptNeedsRepair(attempt.finalText);
    if (verdict.needsRepair) {
      lastError = verdict.error ?? "invalid receipt";
      if (repair < maxRepairs) continue;
      return withOptional(
        {
          outcome: "failed" as const,
          error: `Receipt invalid after ${maxRepairs} repair attempt(s): ${lastError}`,
        },
        extras,
      );
    }

    if (!attempt.finalText.trim() && !verdict.receipt) {
      return withOptional({ outcome: "nothing" as const }, extras);
    }
    return withOptional(
      { outcome: "done" as const, ...(verdict.receipt ? { receipt: verdict.receipt } : {}) },
      extras,
    );
  }

  return {
    outcome: "failed",
    error: lastError ?? "Receipt repair exhausted",
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
  };
}
