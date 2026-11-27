import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDoubaoApiKey } from "../plugins/agents/index.ts";
import { ChannelDispatcher } from "../plugins/channels/index.ts";
import type { AppConfig } from "../protocol/types.ts";
import { createWorker, type Worker } from "../worker/index.ts";
import { HubServer, type HubServerOptions } from "./server.ts";

export type StudioOptions = HubServerOptions & {
  /** Skip embedding a local worker even if config.worker.enabled is true. */
  embedWorker?: boolean;
  /** Skip embedding ChannelDispatcher for desktop/feishu/webhook. */
  embedChannels?: boolean;
};

function enabledDispatchChannels(config: AppConfig): string[] {
  const channels: string[] = [];
  if (config.channels.desktop?.enabled) channels.push("desktop");
  if (config.channels.feishu?.enabled) channels.push("feishu");
  if (config.channels.webhook?.enabled) channels.push("webhook");
  return channels;
}

/**
 * Composition root for `up`: Hub HTTP API + static web console + local worker +
 * source/channel plugins. Unit tests can keep using HubServer/startHub alone.
 */
export class Studio {
  readonly server: HubServer;
  readonly embedWorker: boolean;
  readonly embedChannels: boolean;
  private worker: Worker | undefined;
  private workerKey: string | undefined;
  private dispatcher: ChannelDispatcher | undefined;
  private unlistenConfig: () => void;
  private syncing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: StudioOptions = {}) {
    this.server = new HubServer(options);
    this.embedWorker = options.embedWorker !== false;
    this.embedChannels = options.embedChannels !== false;
    this.unlistenConfig = this.server.runtime.onConfigChange(() => this.scheduleSync());
  }

  get url(): string {
    return this.server.url;
  }

  get port(): number {
    return this.server.port;
  }

  async listen(port?: number, host?: string): Promise<this> {
    await this.server.listen(port, host);
    await this.syncSidecars();
    return this;
  }

  /** Wait until worker/channel sidecars have applied the latest config and secrets. */
  async whenSynced(): Promise<void> {
    await this.syncing;
  }

  private scheduleSync(): void {
    this.syncing = this.syncing
      .then(() => this.syncSidecars())
      .catch((error) => {
        console.error("studio sidecar sync failed", error);
      });
  }

  private async syncSidecars(): Promise<void> {
    if (this.closed) return;
    const runtime = this.server.runtime;
    const config = runtime.config;

    if (this.embedWorker && config.worker.enabled) {
      const stateDir = runtime.memory ? join(process.cwd(), ".autoloop-worker-state") : join(runtime.dataDir, "worker-state");
      mkdirSync(stateDir, { recursive: true });
      const doubaoKey = resolveDoubaoApiKey(config.agents.doubao, runtime.secrets);
      const desired = {
        name: config.worker.name || "local",
        capacity: config.worker.capacity,
        pollTimeoutMs: config.worker.pollTimeoutMs,
        agents: config.agents,
        stateDir,
        doubaoKeyFp: doubaoKey ? createHash("sha256").update(doubaoKey).digest("hex") : "",
      };
      const key = JSON.stringify(desired);
      if (this.workerKey !== key) {
        if (this.worker) await this.worker.stop();
        this.worker = createWorker({
          hubUrl: this.server.url,
          name: desired.name,
          capacity: desired.capacity,
          pollTimeoutMs: desired.pollTimeoutMs,
          stateDir: desired.stateDir,
          agentsConfig: desired.agents,
          secrets: runtime.secrets,
          log: (line) => console.log(line),
        });
        this.workerKey = key;
        this.worker.start();
      }
    } else if (this.worker) {
      await this.worker.stop();
      this.worker = undefined;
      this.workerKey = undefined;
    }

    const channels = this.embedChannels ? enabledDispatchChannels(config) : [];
    if (this.dispatcher) {
      this.dispatcher.stop();
      this.dispatcher = undefined;
    }
    if (channels.length > 0) {
      this.dispatcher = new ChannelDispatcher({
        baseUrl: this.server.url,
        config,
        secrets: runtime.secrets,
        channels,
        waitMs: Math.min(config.worker.pollTimeoutMs || 30_000, 30_000),
        retryMs: 1_000,
        onError: (err, context) => {
          const where = context?.channel ? `channel ${context.channel}` : "dispatcher";
          const message = err instanceof Error ? err.message : String(err);
          console.error(`${where}: ${message}`);
        },
      });
      this.dispatcher.start();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unlistenConfig();
    await this.syncing.catch(() => undefined);
    if (this.dispatcher) {
      this.dispatcher.stop();
      this.dispatcher = undefined;
    }
    if (this.worker) {
      await this.worker.stop();
      this.worker = undefined;
      this.workerKey = undefined;
    }
    await this.server.close();
  }
}

export async function startStudio(options: StudioOptions = {}): Promise<Studio> {
  const studio = new Studio(options);
  try {
    await studio.listen(options.port, options.host);
    return studio;
  } catch (error) {
    await studio.close().catch(() => undefined);
    throw error;
  }
}
