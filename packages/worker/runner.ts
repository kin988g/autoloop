import { spawn, type ChildProcess } from "node:child_process";
import type { AgentAdapter, AppConfig, Job } from "../plugins/agents/types.ts";
import { getAgentAdapter } from "../plugins/agents/index.ts";
import {
  runWithReceiptRepair,
  type AgentAttempt,
  type RunResultPayload,
} from "./contract.ts";
import { buildAgentPrompt, writeContextFile } from "./prompt.ts";

export type { RunOutcome, RunResultPayload } from "./contract.ts";

const DEFAULT_TIMEOUT_MINUTES = 180;
const DEFAULT_GRACE_MS = 2_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

export interface ExecuteJobOptions {
  stateDir: string;
  agentsConfig?: AppConfig["agents"];
  secrets?: Record<string, string>;
  timeoutMs?: number;
  graceMs?: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
  adapter?: AgentAdapter;
  maxRepairAttempts?: number;
}

export interface ResolvedSpawn {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Quote one argument for `cmd.exe /d /s /c` so it remains a single token
 * and cannot inject metacharacters or expand `%VAR%`.
 */
export function quoteWindowsCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  const needsQuotes = /[\s"&<>|^!()%]/.test(arg);
  if (!needsQuotes) return arg;
  const quoted = `"${arg.replace(/"/g, '""')}"`;
  // Break out of quotes around `%` so `^` can prevent env-var expansion.
  return quoted.replace(/%/g, '"^%"');
}

/**
 * Rewrite a spawn target so Windows `.cmd` / `.bat` / `.ps1` wrappers run
 * without ENOENT or shell injection. On other platforms this is a no-op
 * (callers should pass the raw bin/args through unchanged).
 */
export function resolveWindowsSpawn(bin: string, args: string[]): ResolvedSpawn {
  const lower = bin.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bin, ...args],
    };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const commandLine = [quoteWindowsCmdArg(bin), ...args.map(quoteWindowsCmdArg)].join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }
  return { command: bin, args };
}

class HeadTailBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  #head: number;
  #tail: number;

  constructor(headBytes: number, tailBytes: number) {
    this.#head = headBytes;
    this.#tail = tailBytes;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    const keep = this.#head + this.#tail;
    // Bound memory: drop from the middle once far past head+tail.
    if (this.#size > keep * 4) this.#compact();
  }

  toString(): string {
    this.#compact();
    if (this.#chunks.length === 0) return "";
    const buffer = Buffer.concat(this.#chunks);
    if (buffer.length <= this.#head + this.#tail) return buffer.toString("utf8");
    return `${buffer.subarray(0, this.#head).toString("utf8")}\n${buffer
      .subarray(buffer.length - this.#tail)
      .toString("utf8")}`;
  }

  #compact(): void {
    if (this.#chunks.length <= 1) return;
    const buffer = Buffer.concat(this.#chunks);
    if (buffer.length <= this.#head + this.#tail) {
      this.#chunks = [buffer];
      this.#size = buffer.length;
      return;
    }
    this.#chunks = [
      buffer.subarray(0, this.#head),
      buffer.subarray(buffer.length - this.#tail),
    ];
    this.#size = this.#head + this.#tail;
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function timeoutMsFor(job: Job, override?: number): number {
  if (override !== undefined) return override;
  const minutes = job.rule.agent.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

function tailText(text: string, length = 500): string {
  const cut = text.trim().slice(-length);
  return /^[\udc00-\udfff]/.test(cut) ? cut.slice(1) : cut;
}

export function spawnAgentAttempt(
  job: Job,
  prompt: string,
  contextPath: string,
  adapter: AgentAdapter,
  options: {
    timeoutMs: number;
    graceMs: number;
    signal?: AbortSignal;
    headBytes?: number;
    tailBytes?: number;
  },
): Promise<AgentAttempt> {
  const spec = adapter.buildCommand(job, prompt, contextPath);
  const headBytes = options.headBytes ?? HEAD_BYTES;
  const tailBytes = options.tailBytes ?? TAIL_BYTES;
  const stdoutBuf = new HeadTailBuffer(headBytes, tailBytes);
  const stderrBuf = new HeadTailBuffer(headBytes, tailBytes);
  const detached = process.platform !== "win32";

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;

    const invocation =
      process.platform === "win32" ? resolveWindowsSpawn(spec.bin, spec.args) : { command: spec.bin, args: spec.args };

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: job.rule.agent.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (attempt: AgentAttempt) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(attempt);
    };

    const startHardKill = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, options.graceMs);
    };

    const onAbort = () => {
      cancelled = true;
      killProcessGroup(child, "SIGTERM");
      startHardKill();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuf.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => {
      if (settled) return;
      finish({
        finalText: "",
        exitCode: null,
        error: error.message,
      });
    });
    child.on("exit", (code, signal) => {
      const stdout = stdoutBuf.toString();
      const stderr = stderrBuf.toString();
      const parsed = adapter.parseOutput(stdout, stderr);
      if (cancelled) {
        finish({
          ...parsed,
          exitCode: code,
          cancelled: true,
          error: "Cancelled",
        });
        return;
      }
      if (timedOut) {
        finish({
          ...parsed,
          exitCode: code,
          timedOut: true,
          error: `Timed out after ${options.timeoutMs}ms${signal ? ` (${signal})` : ""}`,
        });
        return;
      }
      const error =
        code !== 0 && code !== null
          ? `Agent exited with code ${code}${stderr.trim() ? `: ${tailText(stderr)}` : ""}`
          : undefined;
      finish({
        ...parsed,
        exitCode: code,
        ...(error ? { error } : {}),
      });
    });

    if (options.timeoutMs > 0 && Number.isFinite(options.timeoutMs)) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
        startHardKill();
      }, options.timeoutMs);
    }

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeJob(job: Job, options: ExecuteJobOptions): Promise<RunResultPayload> {
  const adapter = options.adapter ?? getAgentAdapter(job.rule.agent.adapter, options.agentsConfig, options.secrets);
  const contextPath = await writeContextFile(job, options.stateDir);
  const prompt = buildAgentPrompt(job, contextPath);
  const timeoutMs = timeoutMsFor(job, options.timeoutMs);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const headBytes = HEAD_BYTES;
  const tailBytes = options.maxBufferBytes ?? TAIL_BYTES;

  return runWithReceiptRepair(
    job,
    prompt,
    (currentJob, currentPrompt) =>
      spawnAgentAttempt(currentJob, currentPrompt, contextPath, adapter, {
        timeoutMs,
        graceMs,
        signal: options.signal,
        headBytes,
        tailBytes,
      }),
    { maxRepairs: options.maxRepairAttempts },
  );
}
