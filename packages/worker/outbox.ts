import { mkdirSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunResultPayload } from "./contract.ts";

export interface PendingResult {
  runId: string;
  runToken: string;
  result: RunResultPayload;
}

export class ResultOutbox {
  private db: DatabaseSync;
  private hub: string;

  constructor(dir: string, hub: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "results.sqlite");
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file);
    this.hub = hub;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS results (
        hub TEXT NOT NULL, run_id TEXT NOT NULL, token TEXT NOT NULL, payload TEXT NOT NULL,
        rejection TEXT, PRIMARY KEY (hub, run_id, token)
      );
    `);
  }

  save(entry: PendingResult): void {
    this.db.prepare("INSERT INTO results (hub, run_id, token, payload) VALUES (?, ?, ?, ?)")
      .run(this.hub, entry.runId, entry.runToken, JSON.stringify(entry.result));
  }

  pending(): PendingResult[] {
    return this.db.prepare("SELECT run_id, token, payload FROM results WHERE hub = ? AND rejection IS NULL")
      .all(this.hub).map(row => ({
        runId: String(row.run_id), runToken: String(row.token), result: JSON.parse(String(row.payload)),
      }));
  }

  acknowledge(entry: PendingResult): void {
    this.db.prepare("DELETE FROM results WHERE hub = ? AND run_id = ? AND token = ?")
      .run(this.hub, entry.runId, entry.runToken);
  }

  reject(entry: PendingResult, reason: string): void {
    this.db.prepare("UPDATE results SET rejection = ? WHERE hub = ? AND run_id = ? AND token = ?")
      .run(reason, this.hub, entry.runId, entry.runToken);
  }

  close(): void {
    this.db.close();
  }
}
