import type { AppConfig, Job } from "../plugins/agents/types.ts";
import { setTimeout as waitDelay } from "node:timers/promises";
import { ResultOutbox, type PendingResult } from "./outbox.ts";
import { HubClient, HubError } from "./client.ts";
import { executeJob, type ExecuteJobOptions, type RunResultPayload } from "./runner.ts";

const DEFAULT_CAPACITY = 2;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

export interface WorkerOptions {
  hubUrl?: string;
  client?: HubClient;
  name: string;
  capacity?: number;
  pollTimeoutMs?: number;
  heartbeatMs?: number;
  authToken?: string;
  stateDir: string;
  agentsConfig?: AppConfig["agents"];
  secrets?: Record<string, string>;
  timeoutMs?: number;
  graceMs?: number;
  log?: (line: string) => void;
}

interface RunningRun {
  controller: AbortController;
  promise: Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export class Worker {
  #client: HubClient;
  #name: string;
  #capacity: number;
  #pollTimeoutMs: number;
  #heartbeatMs: number;
  #stateDir: string;
  #executeOptions: Pick<ExecuteJobOptions, "agentsConfig" | "secrets" | "timeoutMs" | "graceMs">;
  #log: (line: string) => void;
  #running = new Map<string, RunningRun>();
  #pollController: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #stopping = false;
  #outbox?: ResultOutbox;

  constructor(options: WorkerOptions) {
    this.#client =
      options.client ??
      new HubClient({
        baseUrl: options.hubUrl ?? "http://127.0.0.1:3350",
        authToken: options.authToken,
      });
    this.#name = options.name;
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#stateDir = options.stateDir;
    this.#executeOptions = {
      agentsConfig: options.agentsConfig,
      secrets: options.secrets,
      timeoutMs: options.timeoutMs,
      graceMs: options.graceMs,
    };
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (this.#loop) return;
    this.#stopping = false;
    this.#pollController = new AbortController();
    this.#outbox = new ResultOutbox(this.#stateDir, this.#client.baseUrl);
    for (const entry of this.#outbox.pending()) {
      this.#track(entry.runId, () => this.#deliver(entry));
    }
    this.#loop = this.#pollLoop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#pollController?.abort();
    for (const runId of this.getRunningIds()) this.cancelRun(runId);
    if (this.#loop) {
      try {
        await this.#loop;
      } catch {
        // Poll loop errors are logged inside the loop.
      }
    }
    await Promise.allSettled([...this.#running.values()].map((run) => run.promise));
    this.#outbox?.close();
    this.#outbox = undefined;
    this.#loop = undefined;
    this.#pollController = undefined;
  }

  cancelRun(runId: string): boolean {
    const run = this.#running.get(runId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  getRunningIds(): string[] {
    return [...this.#running.keys()];
  }

  async #pollLoop(): Promise<void> {
    let failures = 0;
    this.#log(`worker ${this.#name} started`);
    while (!this.#stopping) {
      const signal = this.#pollController?.signal;
      try {
        const running = this.getRunningIds();
        const waitMs = running.length > 0 ? this.#heartbeatMs : this.#pollTimeoutMs;
        const job = await this.#client.pollWork({
          worker: this.#name,
          capacity: this.#capacity,
          running,
          waitMs,
          signal,
        });
        failures = 0;
        if (job) this.#begin(job);
      } catch (error) {
        if (this.#stopping || isAbortError(error)) break;
        const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
        failures += 1;
        this.#log(`poll error (${failures}): ${(error as Error).message}; retrying in ${delay}ms`);
        try {
          await waitDelay(delay, undefined, { signal });
        } catch {
          break;
        }
      }
    }
  }

  #begin(job: Job): void {
    if (this.#stopping) return;
    if (this.#running.has(job.runId)) {
      this.#log(`run ${job.runId} is already running; ignoring duplicate job`);
      return;
    }
    if (this.#running.size >= this.#capacity) {
      this.#log(`at capacity (${this.#capacity}); not starting run ${job.runId}`);
      return;
    }
    this.#track(job.runId, controller => this.#execute(job, controller));
  }

  #track(runId: string, work: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController();
    const promise = work(controller).catch(error => {
      this.#log(`run ${runId}: result storage failure, stopping polling: ${error}`);
      this.#stopping = true;
      this.#pollController?.abort();
    }).finally(() => { this.#running.delete(runId); });
    this.#running.set(runId, { controller, promise });
  }

  async #execute(job: Job, controller: AbortController): Promise<void> {
    let result: RunResultPayload | undefined;
    try {
      await this.#client.reportStarted(job.runId, job.runToken);
      this.#log(`run ${job.runId} started (${job.rule.name})`);
      result = await executeJob(job, {
        stateDir: this.#stateDir,
        signal: controller.signal,
        ...this.#executeOptions,
      });
    } catch (error) {
      result = {
        outcome: controller.signal.aborted ? "cancelled" : "failed",
        error: (error as Error).message ?? String(error),
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      };
    }
    const entry = { runId: job.runId, runToken: job.runToken, result };
    this.#outbox!.save(entry);
    await this.#deliver(entry);
  }

  async #deliver(entry: PendingResult): Promise<void> {
    const signal = this.#pollController!.signal;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const ack = await this.#client.reportResult(entry.runId, entry.runToken, entry.result, signal);
        if (ack?.ok !== true) throw new Error("missing Hub acknowledgement");
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof HubError && [400, 404, 409, 422].includes(error.status)) {
          this.#outbox!.reject(entry, error.message);
          this.#log(`run ${entry.runId}: rejected result retained for review: ${error.message}`);
          return;
        }
        const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        this.#log(`run ${entry.runId}: result pending, retrying in ${delay}ms: ${error}`);
        await waitDelay(delay, undefined, { signal }).catch(() => {});
        continue;
      }
      this.#outbox!.acknowledge(entry);
      this.#log(`run ${entry.runId}: ${entry.result.outcome}`);
      return;
    }
  }
}

export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}
