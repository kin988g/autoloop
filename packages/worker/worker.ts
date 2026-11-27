import type { AppConfig, Job } from "../plugins/agents/types.ts";
import { HubClient } from "./client.ts";
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
  job: Job;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
          await sleep(delay, signal);
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
    const controller = new AbortController();
    const promise = this.#execute(job, controller);
    this.#running.set(job.runId, { controller, promise, job });
    void promise.finally(() => {
      this.#running.delete(job.runId);
    });
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
    try {
      await this.#client.reportResult(job.runId, job.runToken, result);
      this.#log(`run ${job.runId}: ${result.outcome}`);
    } catch (error) {
      this.#log(`run ${job.runId}: failed to report result: ${(error as Error).message}`);
    }
  }
}

export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}
