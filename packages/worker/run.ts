import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createWorker, type WorkerOptions } from "./worker.ts";

export interface CliOptions {
  hub: string;
  name: string;
  capacity: number;
  pollTimeoutMs: number;
  token?: string;
  stateDir: string;
  heartbeatMs?: number;
}

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function parseArgs(argv: string[]): CliOptions {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    throw new Error("help");
  }
  const capacityRaw = readArg(argv, "--capacity") ?? env("AUTOLOOP_CAPACITY") ?? "2";
  const pollRaw =
    readArg(argv, "--poll-timeout") ??
    env("AUTOLOOP_POLL_TIMEOUT") ??
    env("AUTOLOOP_POLL_TIMEOUT_MS") ??
    "30000";
  const heartbeatRaw = readArg(argv, "--heartbeat") ?? env("AUTOLOOP_HEARTBEAT_MS");
  const capacity = Number(capacityRaw);
  const pollTimeoutMs = Number(pollRaw);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`Invalid --capacity: ${capacityRaw}`);
  }
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs < 0) {
    throw new Error(`Invalid --poll-timeout: ${pollRaw}`);
  }
  const options: CliOptions = {
    hub:
      readArg(argv, "--hub") ??
      env("AUTOLOOP_HUB") ??
      env("AUTOLOOP_HUB_URL") ??
      "http://127.0.0.1:3350",
    name:
      readArg(argv, "--name") ??
      env("AUTOLOOP_WORKER_NAME") ??
      env("AUTOLOOP_NAME") ??
      hostname() ??
      "worker",
    capacity,
    pollTimeoutMs,
    token: readArg(argv, "--token") ?? env("AUTOLOOP_TOKEN") ?? env("AUTOLOOP_AUTH_TOKEN"),
    stateDir:
      readArg(argv, "--state-dir") ??
      env("AUTOLOOP_STATE_DIR") ??
      path.resolve("autoloop-worker-state"),
  };
  if (heartbeatRaw !== undefined) {
    const heartbeatMs = Number(heartbeatRaw);
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
      throw new Error(`Invalid --heartbeat: ${heartbeatRaw}`);
    }
    options.heartbeatMs = heartbeatMs;
  }
  return options;
}

export const usage = `Usage: node packages/worker/run.ts [options]

  --hub <url>            Hub base URL (env AUTOLOOP_HUB, default http://127.0.0.1:3350)
  --name <name>          Worker name (env AUTOLOOP_WORKER_NAME)
  --capacity <n>         Max concurrent runs (env AUTOLOOP_CAPACITY, default 2)
  --poll-timeout <ms>    Long-poll wait when idle (env AUTOLOOP_POLL_TIMEOUT, default 30000)
  --heartbeat <ms>       Poll interval while runs are active (env AUTOLOOP_HEARTBEAT_MS)
  --token <token>        Bearer token for the hub (env AUTOLOOP_TOKEN)
  --state-dir <dir>      Directory for per-run context.json files (env AUTOLOOP_STATE_DIR)
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if ((error as Error).message === "help") {
      console.log(usage);
      return;
    }
    console.error((error as Error).message);
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  await mkdir(options.stateDir, { recursive: true });
  const workerOptions: WorkerOptions = {
    hubUrl: options.hub,
    name: options.name,
    capacity: options.capacity,
    pollTimeoutMs: options.pollTimeoutMs,
    heartbeatMs: options.heartbeatMs,
    authToken: options.token,
    stateDir: options.stateDir,
    log: (line) => console.log(line),
  };
  const worker = createWorker(workerOptions);
  worker.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`received ${signal}; shutting down`);
    try {
      await worker.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  await main(process.argv.slice(2));
}
