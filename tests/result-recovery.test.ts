import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../packages/host/server.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for recovery");
    await delay(20);
  }
}

async function kill(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
}

for (const scenario of [
  { fault: "disconnect before commit", restart: false },
  { fault: "disconnect before commit", restart: true },
  { fault: "lose acknowledgement after commit", restart: true },
]) {
  const { fault, restart } = scenario;
  it(`recovers after ${fault}, ${restart ? "with" : "without"} restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "autoloop-recovery-"));
    const hubDir = join(dir, "hub");
    let hub = await startHub({ port: 0, dataDir: hubDir });
    let offline = true;
    let dropped = 0;
    const acknowledgements: string[] = [];
    const proxy = createServer((req, res) => {
      const isResult = req.url?.endsWith("/result");
      if (isResult && offline && fault === "disconnect before commit") {
        dropped++;
        res.destroy();
        return;
      }
      const upstream = request(new URL(req.url!, hub.url), { method: req.method, headers: { ...req.headers, connection: "close" } }, reply => {
        if (!isResult) {
          res.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(res);
          return;
        }
        let body = "";
        reply.setEncoding("utf8").on("data", chunk => { body += chunk; });
        reply.on("end", () => {
          acknowledgements.push(body);
          if (offline) {
            dropped++;
            res.destroy();
          } else {
            res.writeHead(reply.statusCode!, reply.headers);
            res.end(body);
          }
        });
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const workerDir = join(dir, "worker");
    const launch = () => spawn(process.execPath, [
      "packages/worker/cli.ts", "--hub", url, "--state-dir", workerDir,
      "--poll-timeout", "50", "--heartbeat", "50",
    ], { stdio: "ignore" });
    let worker: ChildProcess | undefined;
    try {
      const stamp = join(dir, "executions");
      const agent = `require("node:fs").appendFileSync(${JSON.stringify(stamp)}, "1");
        console.log(JSON.stringify({finalText: ${JSON.stringify('```agent-autoloop\n{"notice":{"title":"done","body":"completed"}}\n```')}}));`;
      hub.runtime.setRules({ rules: [{
        name: "recover", enabled: true, trigger: { type: "manual" }, channels: ["web"],
        agent: { adapter: "command", cwd: dir, access: "plan", prompt: "test", command: [process.execPath, "-e", agent] },
      }] });
      hub.runtime.runRule("recover");
      worker = launch();
      await until(() => dropped >= 2); // includes an automatic retry before restarting
      assert.equal(hub.runtime.view.cards.length, fault === "disconnect before commit" ? 0 : 1);
      if (restart) {
        await kill(worker);
        await hub.close();
        hub = await startHub({ port: 0, dataDir: hubDir });
        worker = launch();
      }
      offline = false;
      const outbox = new DatabaseSync(join(workerDir, "results.sqlite"));
      try {
        await until(() => outbox.prepare("SELECT count(*) AS n FROM results").get()?.n === 0);
      } finally {
        outbox.close();
      }
      assert.equal(readFileSync(stamp, "utf8"), "1");
      assert.equal(hub.runtime.view.runs.length, 1);
      assert.equal(hub.runtime.view.runs[0].status, "done");
      assert.equal(hub.runtime.view.cards.length, 1);
      const expected = { ok: true, cardId: hub.runtime.view.cards[0].id };
      assert.ok(acknowledgements.length);
      for (const body of acknowledgements) assert.deepEqual(JSON.parse(body), expected);
    } finally {
      if (worker) await kill(worker);
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
