import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  claudeAdapter,
  codexAdapter,
  commandAdapter,
  createAgentRegistry,
  createClaudeAdapter,
  createCodexAdapter,
  createCommandAdapter,
  createCursorAdapter,
  createDoubaoAdapter,
  cursorAdapter,
  doubaoAdapter,
  extractReceipt,
  getAgentAdapter,
  parseReceipt,
  resolveCursorAgentBin,
  resolveDoubaoApiKey,
  resolveDoubaoRunnerPath,
  DEFAULT_DOUBAO_BASE_URL,
  DEFAULT_DOUBAO_MODEL,
} from "./index.ts";
import type { Job, Rule } from "./types.ts";

function rule(overrides: Partial<Rule["agent"]> = {}): Rule {
  return {
    name: "demo",
    enabled: true,
    trigger: { type: "manual" },
    agent: {
      adapter: "claude",
      cwd: "/tmp",
      access: "plan",
      prompt: "Do the work.",
      ...overrides,
    },
    channels: ["web"],
  };
}

function job(overrides: Partial<Job> = {}, agent: Partial<Rule["agent"]> = {}): Job {
  return {
    runId: "run-1",
    attempt: 1,
    runToken: "tok-1",
    rule: rule(agent),
    lane: "inbox",
    context: { events: [], openCards: [] },
    ...overrides,
  };
}

const contextPath = "/tmp/run-1/context.json";
const prompt = "Trusted prompt";

describe("claude adapter", () => {
  it("builds a plan-mode command with output-format json and env", () => {
    const spec = claudeAdapter.buildCommand(job(), prompt, contextPath);
    assert.equal(spec.bin, "claude");
    assert.deepEqual(spec.args, [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
    ]);
    assert.deepEqual(spec.env, {
      AUTOLOOP_CONTEXT_PATH: contextPath,
      AUTOLOOP_RUN_ID: "run-1",
      AUTOLOOP_LANE: "inbox",
      AUTOLOOP_RULE_NAME: "demo",
    });
  });

  it("maps access modes and resumes a session", () => {
    const accept = claudeAdapter.buildCommand(
      job({ sessionId: "sess-9" }, { access: "acceptEdits" }),
      prompt,
      contextPath,
    );
    assert.ok(accept.args.includes("--permission-mode"));
    assert.equal(accept.args[accept.args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.ok(accept.args.includes("--resume"));
    assert.equal(accept.args[accept.args.indexOf("--resume") + 1], "sess-9");

    const bypass = claudeAdapter.buildCommand(
      job({}, { access: "bypassPermissions" }),
      prompt,
      contextPath,
    );
    assert.equal(bypass.args[bypass.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  });

  it("uses a custom bin and defaultAccess fallback from the factory", () => {
    const adapter = createClaudeAdapter({ bin: "/opt/claude", defaultAccess: "acceptEdits" });
    const spec = adapter.buildCommand(job({}, { access: "plan" }), prompt, contextPath);
    assert.equal(spec.bin, "/opt/claude");
    assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "plan");
  });

  it("parses a single JSON result", () => {
    const parsed = claudeAdapter.parseOutput(
      JSON.stringify({
        type: "result",
        result: "All done.",
        session_id: "s-1",
        usage: { input_tokens: 11, output_tokens: 7, note: "ignore" },
      }),
      "",
    );
    assert.equal(parsed.finalText, "All done.");
    assert.equal(parsed.sessionId, "s-1");
    assert.deepEqual(parsed.usage, { input_tokens: 11, output_tokens: 7 });
  });

  it("parses stream-json / NDJSON and prefers the last result", () => {
    const stdout = [
      JSON.stringify({ type: "system", session_id: "s-2" }),
      JSON.stringify({ type: "assistant", message: { content: "thinking" } }),
      JSON.stringify({
        type: "result",
        result: "Final answer",
        sessionId: "s-2b",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    ].join("\n");
    const parsed = claudeAdapter.parseOutput(stdout, "");
    assert.equal(parsed.finalText, "Final answer");
    assert.equal(parsed.sessionId, "s-2b");
    assert.deepEqual(parsed.usage, { input_tokens: 3, output_tokens: 4 });
  });

  it("falls back to trimmed raw stdout when output is not JSON", () => {
    const parsed = claudeAdapter.parseOutput("  plain text result  \n", "warn");
    assert.deepEqual(parsed, { finalText: "plain text result" });
  });
});

describe("codex adapter", () => {
  it("builds exec --json with sandbox mapped from access", () => {
    const plan = codexAdapter.buildCommand(job({}, { access: "plan" }), prompt, contextPath);
    assert.equal(plan.bin, "codex");
    assert.deepEqual(plan.args, ["exec", "--sandbox", "read-only", "--json", prompt]);

    const edit = codexAdapter.buildCommand(
      job({}, { access: "acceptEdits" }),
      prompt,
      contextPath,
    );
    assert.deepEqual(edit.args, ["exec", "--sandbox", "workspace-write", "--json", prompt]);

    const bypass = codexAdapter.buildCommand(
      job({}, { access: "bypassPermissions" }),
      prompt,
      contextPath,
    );
    assert.deepEqual(bypass.args, [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      prompt,
    ]);
    assert.deepEqual(plan.env, {
      AUTOLOOP_CONTEXT_PATH: contextPath,
      AUTOLOOP_RUN_ID: "run-1",
      AUTOLOOP_LANE: "inbox",
      AUTOLOOP_RULE_NAME: "demo",
    });
  });

  it("resumes with exec resume <sessionId> --json", () => {
    const adapter = createCodexAdapter({ bin: "/usr/bin/codex" });
    const spec = adapter.buildCommand(
      job({ sessionId: "thr_123" }, { access: "plan" }),
      prompt,
      contextPath,
    );
    assert.equal(spec.bin, "/usr/bin/codex");
    assert.deepEqual(spec.args, [
      "exec",
      "resume",
      "thr_123",
      "--sandbox",
      "read-only",
      "--json",
      prompt,
    ]);
  });

  it("parses JSONL thread/item/turn events", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thr_abc" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Here is the answer." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 9, output_tokens: 2, cached_input_tokens: 4 },
      }),
    ].join("\n");
    const parsed = codexAdapter.parseOutput(stdout, "");
    assert.equal(parsed.finalText, "Here is the answer.");
    assert.equal(parsed.sessionId, "thr_abc");
    assert.deepEqual(parsed.usage, {
      input_tokens: 9,
      output_tokens: 2,
      cached_input_tokens: 4,
    });
  });

  it("parses a single JSON object and falls back to plain text", () => {
    const single = codexAdapter.parseOutput(
      JSON.stringify({ finalText: "ok", sessionId: "s", usage: { output_tokens: 1 } }),
      "",
    );
    assert.equal(single.finalText, "ok");
    assert.equal(single.sessionId, "s");
    assert.deepEqual(single.usage, { output_tokens: 1 });

    const plain = codexAdapter.parseOutput("just text\n", "");
    assert.equal(plain.finalText, "just text");
  });
});

describe("command adapter", () => {
  it("throws when command is missing or empty", () => {
    assert.throws(
      () => commandAdapter.buildCommand(job(), prompt, contextPath),
      /command adapter requires rule.agent.command/,
    );
    assert.throws(
      () => commandAdapter.buildCommand(job({}, { command: [] }), prompt, contextPath),
      /command adapter requires rule.agent.command/,
    );
  });

  it("uses command[0] as bin and substitutes placeholders, including session env", () => {
    const spec = commandAdapter.buildCommand(
      job({ sessionId: "sess-x" }, {
        command: [
          "/usr/bin/agent",
          "--prompt",
          "{prompt}",
          "--context",
          "{contextPath}",
          "--run",
          "{runId}",
          "--lane",
          "{lane}",
          "--session",
          "{sessionId}",
        ],
      }),
      prompt,
      contextPath,
    );
    assert.equal(spec.bin, "/usr/bin/agent");
    assert.deepEqual(spec.args, [
      "--prompt",
      prompt,
      "--context",
      contextPath,
      "--run",
      "run-1",
      "--lane",
      "inbox",
      "--session",
      "sess-x",
    ]);
    assert.equal(spec.env?.AUTOLOOP_CONTEXT_PATH, contextPath);
    assert.equal(spec.env?.AUTOLOOP_RUN_ID, "run-1");
    assert.equal(spec.env?.AUTOLOOP_LANE, "inbox");
    assert.equal(spec.env?.AUTOLOOP_RULE_NAME, "demo");
    assert.equal(spec.env?.AUTOLOOP_PROMPT, prompt);
    assert.equal(spec.env?.AUTOLOOP_SESSION_ID, "sess-x");
  });

  it("omits AUTOLOOP_SESSION_ID when the job has no session", () => {
    const spec = commandAdapter.buildCommand(
      job({}, { command: ["echo", "{sessionId}"] }),
      prompt,
      contextPath,
    );
    assert.equal(spec.args[0], "");
    assert.equal(spec.env?.AUTOLOOP_SESSION_ID, undefined);
  });

  it("returns trimmed stdout, and extracts fields from a JSON object with finalText", () => {
    assert.deepEqual(commandAdapter.parseOutput("  hello world  \n", ""), {
      finalText: "hello world",
    });
    const parsed = commandAdapter.parseOutput(
      JSON.stringify({
        finalText: "from json",
        sessionId: "s-json",
        usage: { input_tokens: 2, output_tokens: 8 },
      }),
      "",
    );
    assert.equal(parsed.finalText, "from json");
    assert.equal(parsed.sessionId, "s-json");
    assert.deepEqual(parsed.usage, { input_tokens: 2, output_tokens: 8 });
  });

  it("exports a factory identical to the default adapter", () => {
    assert.equal(createCommandAdapter().name, "command");
  });
});

describe("cursor adapter", () => {
  const adapter = createCursorAdapter({ bin: "agent" });

  it("builds a non-interactive JSON command and env", () => {
    const spec = adapter.buildCommand(job({}, { adapter: "cursor", access: "acceptEdits" }), prompt, contextPath);
    assert.equal(spec.bin, "agent");
    assert.deepEqual(spec.args, ["-p", "--output-format", "json", "--trust", prompt]);
    assert.deepEqual(spec.env, {
      AUTOLOOP_CONTEXT_PATH: contextPath,
      AUTOLOOP_RUN_ID: "run-1",
      AUTOLOOP_LANE: "inbox",
      AUTOLOOP_RULE_NAME: "demo",
    });
  });

  it("maps plan and bypassPermissions access, leaving acceptEdits as print mode", () => {
    const plan = adapter.buildCommand(job({}, { adapter: "cursor", access: "plan" }), prompt, contextPath);
    assert.ok(plan.args.includes("--mode"));
    assert.equal(plan.args[plan.args.indexOf("--mode") + 1], "plan");
    assert.equal(plan.args.includes("--force"), false);
    assert.equal(plan.args.at(-1), prompt);

    const bypass = adapter.buildCommand(
      job({}, { adapter: "cursor", access: "bypassPermissions" }),
      prompt,
      contextPath,
    );
    assert.ok(bypass.args.includes("--force"));
    assert.equal(bypass.args.includes("--mode"), false);
    assert.equal(bypass.args.at(-1), prompt);

    const accept = adapter.buildCommand(
      job({}, { adapter: "cursor", access: "acceptEdits" }),
      prompt,
      contextPath,
    );
    assert.equal(accept.args.includes("--mode"), false);
    assert.equal(accept.args.includes("--force"), false);
  });

  it("resumes a session and passes an optional model", () => {
    const spec = adapter.buildCommand(
      job({ sessionId: "sess-cursor" }, { adapter: "cursor", access: "acceptEdits", model: "composer-1" }),
      prompt,
      contextPath,
    );
    assert.ok(spec.args.includes("--resume"));
    assert.equal(spec.args[spec.args.indexOf("--resume") + 1], "sess-cursor");
    assert.ok(spec.args.includes("--model"));
    assert.equal(spec.args[spec.args.indexOf("--model") + 1], "composer-1");
    assert.equal(spec.args.at(-1), prompt);
  });

  it("parses a Cursor JSON result, including usage and session_id", () => {
    const parsed = adapter.parseOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        result: "All done.",
        session_id: "s-cursor",
        usage: { input_tokens: 11, output_tokens: 7, note: "ignore" },
      }),
      "",
    );
    assert.equal(parsed.finalText, "All done.");
    assert.equal(parsed.sessionId, "s-cursor");
    assert.deepEqual(parsed.usage, { input_tokens: 11, output_tokens: 7 });
  });

  it("falls back to trimmed stdout when the output is not JSON", () => {
    assert.deepEqual(adapter.parseOutput("  plain agent text  \n", ""), { finalText: "plain agent text" });
  });

  it("resolves %LOCALAPPDATA%\\cursor-agent wrappers on Windows", () => {
    const localAppData = "C:\\Users\\kwang2\\AppData\\Local";
    const cmdPath = "C:\\Users\\kwang2\\AppData\\Local\\cursor-agent\\agent.cmd";
    const ps1Path = "C:\\Users\\kwang2\\AppData\\Local\\cursor-agent\\agent.ps1";
    assert.equal(
      resolveCursorAgentBin({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData },
        exists: (filePath) => filePath === cmdPath,
      }),
      cmdPath,
    );
    assert.equal(
      resolveCursorAgentBin({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData },
        exists: (filePath) => filePath === ps1Path,
      }),
      ps1Path,
    );
    assert.equal(
      resolveCursorAgentBin({
        bin: "agent",
        platform: "win32",
        env: { LOCALAPPDATA: localAppData },
        exists: () => true,
      }),
      "agent",
    );
    assert.equal(resolveCursorAgentBin({ platform: "linux" }), "agent");
    assert.equal(createCursorAdapter({ bin: "/opt/agent" }).name, "cursor");
    assert.equal(cursorAdapter.name, "cursor");
  });
});


describe("doubao adapter", () => {
  const adapter = createDoubaoAdapter({
    baseUrl: "https://ark.example.com/api/v3",
    model: "doubao-default",
    apiKey: "cfg-key",
  });
  const runnerPath = resolveDoubaoRunnerPath();

  it("builds a node command that passes the prompt via env, not argv", () => {
    const longPrompt = `${prompt}\n${"x".repeat(4000)}`;
    const spec = adapter.buildCommand(
      job({}, { adapter: "doubao", access: "acceptEdits", model: "ep-rule-model" }),
      longPrompt,
      contextPath,
    );
    assert.equal(spec.bin, process.execPath);
    assert.deepEqual(spec.args, [runnerPath]);
    assert.equal(spec.args.includes(longPrompt), false);
    assert.equal(spec.env?.AUTOLOOP_CONTEXT_PATH, contextPath);
    assert.equal(spec.env?.AUTOLOOP_RUN_ID, "run-1");
    assert.equal(spec.env?.AUTOLOOP_LANE, "inbox");
    assert.equal(spec.env?.AUTOLOOP_RULE_NAME, "demo");
    assert.equal(spec.env?.AUTOLOOP_ACCESS, "acceptEdits");
    assert.equal(spec.env?.AUTOLOOP_PROMPT, longPrompt);
    assert.equal(spec.env?.ARK_BASE_URL, "https://ark.example.com/api/v3");
    assert.equal(spec.env?.ARK_MODEL, "ep-rule-model");
    assert.equal(spec.env?.ARK_API_KEY, "cfg-key");
  });

  it("uses config / env model fallbacks and omits ARK_API_KEY when unresolved", () => {
    const noKey = createDoubaoAdapter({ model: "from-config" });
    const plan = noKey.buildCommand(job({}, { adapter: "doubao", access: "plan" }), prompt, contextPath);
    assert.equal(plan.env?.AUTOLOOP_ACCESS, "plan");
    assert.equal(plan.env?.ARK_MODEL, "from-config");
    assert.equal(plan.env?.ARK_BASE_URL, DEFAULT_DOUBAO_BASE_URL);
    assert.equal(plan.env?.ARK_API_KEY, undefined);

    const fallback = createDoubaoAdapter();
    const spec = fallback.buildCommand(job({}, { adapter: "doubao" }), prompt, contextPath);
    assert.equal(spec.env?.ARK_MODEL, process.env.ARK_MODEL?.trim() || DEFAULT_DOUBAO_MODEL);
  });

  it("resolves api keys from the secrets store before environment variables", () => {
    assert.equal(
      resolveDoubaoApiKey({ apiKeySecret: "MY_ARK" }, { MY_ARK: "secret-value" }, {}),
      "secret-value",
    );
    assert.equal(
      resolveDoubaoApiKey({ apiKeySecret: "ARK_API_KEY" }, {}, { ARK_API_KEY: "env-ark", DOUBAO_API_KEY: "env-doubao" }),
      "env-ark",
    );
    assert.equal(
      resolveDoubaoApiKey(undefined, {}, { DOUBAO_API_KEY: "env-doubao" }),
      "env-doubao",
    );
  });

  it("parses { finalText, usage } JSON and falls back to trimmed stdout", () => {
    const parsed = adapter.parseOutput(
      JSON.stringify({
        finalText: "```agent-autoloop\n{\"notice\":{\"title\":\"ok\",\"body\":\"done\"}}\n```",
        usage: { inputTokens: 42, outputTokens: 33, totalTokens: 75 },
      }),
      "",
    );
    assert.equal(parsed.finalText.includes("agent-autoloop"), true);
    assert.deepEqual(parsed.usage, { inputTokens: 42, outputTokens: 33, totalTokens: 75 });
    assert.deepEqual(adapter.parseOutput("  plain text  \n", ""), { finalText: "plain text" });
    assert.equal(doubaoAdapter.name, "doubao");
  });

  it("runs the runner against a mock Ark server with read_file, write_file, receipt, and usage", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "doubao-runner-"));
    await writeFile(path.join(workDir, "input.txt"), "news-body", "utf8");
    const bodies = [];
    const receipt = "```agent-autoloop\n{\"notice\":{\"title\":\"Rendered\",\"body\":\"Wrote output.md\"}}\n```";

    const server = createServer((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/v3/chat/completions");
      assert.equal(req.headers.authorization, "Bearer mock-key");
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        bodies.push(body);
        const turn = bodies.length;
        if (turn === 1) {
          const names = (body.tools ?? []).map((tool) => tool.function?.name);
          assert.deepEqual(names.sort(), ["list_files", "read_file", "write_file"].sort());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_read",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "input.txt" }) },
                }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        if (turn === 2) {
          const toolMsg = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_read");
          assert.equal(toolMsg?.content, "news-body");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "output.md",
                      content: receipt,
                    }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }));
          return;
        }
        const written = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_write");
        assert.match(written?.content ?? "", /Wrote output.md/);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: receipt } }],
          usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
        }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runnerPath], {
          cwd: workDir,
          env: {
            ...process.env,
            ARK_API_KEY: "mock-key",
            ARK_BASE_URL: `http://127.0.0.1:${port}/api/v3`,
            ARK_MODEL: "doubao-seed-1-6-250615",
            AUTOLOOP_ACCESS: "acceptEdits",
            AUTOLOOP_PROMPT: "Read input.txt and write a receipt to output.md",
            AUTOLOOP_RUN_ID: "run-1",
            AUTOLOOP_LANE: "inbox",
            AUTOLOOP_RULE_NAME: "demo",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = adapter.parseOutput(result.stdout, result.stderr);
      assert.equal(parsed.finalText.includes("agent-autoloop"), true);
      assert.deepEqual(parsed.usage, { inputTokens: 42, outputTokens: 33, totalTokens: 75 });
      assert.equal(await readFile(path.join(workDir, "output.md"), "utf8"), receipt);
      assert.equal(bodies.length, 3);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("registry", () => {
  it("creates adapters from config and looks them up", () => {
    const registry = createAgentRegistry({
      claude: { enabled: true, bin: "claude-bin" },
      codex: { enabled: true, bin: "codex-bin" },
      cursor: { enabled: true, bin: "cursor-bin" },
      command: { enabled: true },
      doubao: { enabled: true, model: "doubao-custom", apiKeySecret: "ARK_API_KEY" },
    }, { ARK_API_KEY: "from-secret" });
    assert.equal(registry.get("claude")?.buildCommand(job(), prompt, contextPath).bin, "claude-bin");
    assert.equal(registry.get("codex")?.buildCommand(job(), prompt, contextPath).bin, "codex-bin");
    assert.equal(registry.get("cursor")?.buildCommand(job({}, { adapter: "cursor" }), prompt, contextPath).bin, "cursor-bin");
    assert.equal(getAgentAdapter("command").name, "command");
    const doubaoSpec = registry.get("doubao")?.buildCommand(job({}, { adapter: "doubao" }), prompt, contextPath);
    assert.equal(doubaoSpec?.bin, process.execPath);
    assert.equal(doubaoSpec?.env?.ARK_MODEL, "doubao-custom");
    assert.equal(doubaoSpec?.env?.ARK_API_KEY, "from-secret");
  });

  it("omits disabled adapters and throws for unknown names", () => {
    const registry = createAgentRegistry({
      claude: { enabled: false },
      command: { enabled: true },
      doubao: { enabled: false },
    });
    assert.equal(registry.has("claude"), false);
    assert.equal(registry.has("doubao"), false);
    assert.throws(() => getAgentAdapter("claude", { claude: { enabled: false } }), /Unknown or disabled/);
    assert.throws(() => getAgentAdapter("doubao", { doubao: { enabled: false } }), /Unknown or disabled/);
    assert.throws(() => getAgentAdapter("unknown"), /Unknown or disabled/);
  });
});

function fence(body: string): string {
  return "```agent-autoloop\n" + body + "\n```";
}

describe("parseReceipt / extractReceipt", () => {
  it("parses notice, resolve, later, events, and ask", () => {
    const text = `Done.\n\n${fence(JSON.stringify({
      ask: { title: "Ship?", body: "Approve the release?", options: ["yes", "no"] },
      notice: { title: "Heads up", body: "Deploying tonight" },
      resolve: { cardId: "card-1", summary: "Fixed" },
      later: { delaySeconds: 60, reason: "wait for CI" },
      events: [{ type: "demo.ping", lane: "inbox", payload: { ok: true } }],
    }))}`;
    const receipt = parseReceipt(text);
    assert.deepEqual(receipt, {
      ask: { title: "Ship?", body: "Approve the release?", options: ["yes", "no"] },
      notice: { title: "Heads up", body: "Deploying tonight" },
      resolve: { cardId: "card-1", summary: "Fixed" },
      later: { delaySeconds: 60, reason: "wait for CI" },
      events: [{ type: "demo.ping", lane: "inbox", payload: { ok: true } }],
    });
  });

  it("uses the last valid block when several are present", () => {
    const text = [
      fence('{"notice":{"title":"first","body":"one"}}'),
      fence("{not-json"),
      fence('{"notice":{"title":"last","body":"two"}}'),
    ].join("\n");
    assert.deepEqual(parseReceipt(text)?.notice, { title: "last", body: "two" });
  });

  it("handles CRLF line endings", () => {
    const text = "```agent-autoloop\r\n{\"notice\":{\"title\":\"crlf\",\"body\":\"ok\"}}\r\n```\r\n";
    assert.deepEqual(parseReceipt(text)?.notice, { title: "crlf", body: "ok" });
  });

  it("ignores malformed JSON and schema-invalid blocks in parseReceipt", () => {
    assert.equal(parseReceipt(fence("{not json")), undefined);
    assert.equal(parseReceipt(fence('{"ask":{"title":1,"body":"x"}}')), undefined);
    assert.equal(parseReceipt(fence('{"later":{"delaySeconds":"soon","reason":"x"}}')), undefined);
    assert.equal(parseReceipt("no receipt here"), undefined);
  });

  it("extractReceipt reports parse and validation errors for repair", () => {
    const badJson = extractReceipt(fence("{nope"));
    assert.match(badJson.error ?? "", /Invalid JSON/);
    const badSchema = extractReceipt(fence('{"notice":{"title":"only"}}'));
    assert.match(badSchema.error ?? "", /notice.body must be a string/);
    const unclosed = extractReceipt("```agent-autoloop\n{\"notice\":{");
    assert.match(unclosed.error ?? "", /not closed/);
    const ok = extractReceipt(fence('{"notice":{"title":"t","body":"b"}}'));
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.receipt?.notice, { title: "t", body: "b" });
  });
});
