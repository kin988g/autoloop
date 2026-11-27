import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { DecisionInput } from "../kernel/decide.ts";
import { Runtime } from "./runtime.ts";

const tables = ["events", "runs", "cards", "deliveries", "timers", "pauses"];
function projection(db: DatabaseSync) {
  return tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

it("matches full projection after each commit and keeps a failed transaction invisible", () => {
  const dir = mkdtempSync(join(tmpdir(), "projection-"));
  const rt = new Runtime({ dataDir: dir });
  const db = new DatabaseSync(join(dir, "hub.db"));
  let time = 100;
  function check(input: DecisionInput) {
    const previous = rt.view;
    const saved = JSON.stringify(previous);
    const { facts } = rt.commit(input, ++time);
    assert.ok(facts.length);
    assert.equal(JSON.stringify(previous), saved);
    const incremental = projection(db);
    const expectedView = JSON.stringify(rt.view);
    assert.equal(JSON.stringify(rt.rebuild()), expectedView);
    assert.deepEqual(projection(db), incremental, input.type);
  }
  try {
    check({ type: "rules", rules: [{ name: "r", enabled: true, trigger: { type: "manual" }, channels: ["web"],
      agent: { adapter: "command", prompt: "test", access: "plan", cwd: dir, command: ["echo"] } }] });
    check({ type: "pause", ruleName: "r" });
    check({ type: "resume", ruleName: "r" });
    check({ type: "manual", ruleName: "r" });
    check({ type: "manual", ruleName: "r" });
    const runId = rt.view.runs[0].id;
    check({ type: "claim", worker: "test", capacity: 1, running: [] });
    check({ type: "started", runId });
    check({ type: "result", runId, outcome: "done", receipt: {
      ask: { title: "Approve?", body: "test" }, later: { reason: "retry", delaySeconds: 1 },
    } });
    const cardId = rt.view.cards[0].id;
    check({ type: "lease", channel: "web" });
    check({ type: "failed", channel: "web", cardId, error: "offline" });
    check({ type: "delivered", channel: "web", cardId, externalId: "remote" });
    const before = projection(db);
    const head = rt.view;
    const countFacts = () => db.prepare("SELECT count(*) AS n FROM fact_log").get()!.n;
    const seq = countFacts();
    db.exec("CREATE TRIGGER fail_card BEFORE UPDATE ON cards BEGIN SELECT RAISE(ABORT,'fault'); END");
    assert.throws(() => rt.answer(cardId, { choice: "yes" }), /fault/);
    assert.equal(rt.view, head);
    assert.deepEqual(projection(db), before);
    assert.equal(countFacts(), seq);
    db.exec("DROP TRIGGER fail_card");
    check({ type: "answer", cardId, text: "approved" });
    check({ type: "cancel", runId: rt.view.runs.at(-1)!.id });
    check({ type: "resolve", cardId });
    time += 2000;
    check({ type: "tick" });
  } finally {
    db.close();
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const phase of ["before", "after"]) {
  it(`recovers when the Hub process dies ${phase} SQLite COMMIT`, () => {
    const dir = mkdtempSync(join(tmpdir(), "projection-crash-"));
    try {
      const script = `
        import { DatabaseSync } from "node:sqlite";
        import { Runtime } from ${JSON.stringify(new URL("./runtime.ts", import.meta.url).href)};
        const runtime = new Runtime({ dataDir: process.argv[1] });
        runtime.setRules({rules:[{name:"r",enabled:true,trigger:{type:"manual"},channels:["web"],
          agent:{adapter:"command",access:"plan",cwd:".",prompt:"test",command:["echo"]}}]});
        runtime.runRule("r");
        const job = runtime.claim("test", 1, []);
        const {cardId} = runtime.result(job.runId,{outcome:"done",receipt:{ask:{title:"?",body:"test"}}});
        const original = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          if (sql !== "COMMIT") return original.call(this, sql);
          if (process.argv[2] === "after") original.call(this, sql);
          process.kill(process.pid, "SIGKILL");
        };
        runtime.answer(cardId, {choice:"yes"});
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir, phase]);
      // Windows reports the exit code of the terminated process instead of a signal.
      if (process.platform !== "win32") assert.equal(child.signal, "SIGKILL", child.stderr.toString());
      else assert.notEqual(child.status, 0);
      const db = new DatabaseSync(join(dir, "hub.db"));
      try {
        const beforeRecovery = projection(db);
        assert.equal(db.prepare("SELECT status FROM cards").get()!.status, phase === "before" ? "open" : "decided");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, phase === "before" ? 1 : 2);
        const recovered = new Runtime({ dataDir: dir });
        try { assert.deepEqual(projection(db), beforeRecovery); }
        finally { recovered.close(); }
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
