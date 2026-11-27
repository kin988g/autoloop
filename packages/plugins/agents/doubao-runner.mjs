import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_TURNS = 10;
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-1-6-250615";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function resolveInsideCwd(relativePath, cwd) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("path is required and must be relative to the working directory");
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the working directory sandbox: ${relativePath}`);
  }
  return resolved;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

function addUsage(acc, usage) {
  if (!usage || typeof usage !== "object") return;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  acc.inputTokens += Number.isFinite(input) ? input : 0;
  acc.outputTokens += Number.isFinite(output) ? output : 0;
  acc.totalTokens += Number.isFinite(total) ? total : 0;
}

function toolSchema(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

function toolsForAccess(access) {
  const tools = [
    toolSchema(
      "read_file",
      "Read a UTF-8 text file. The path must be relative to the working directory and cannot escape it.",
      { path: { type: "string", description: "Path relative to the working directory." } },
      ["path"],
    ),
    toolSchema(
      "list_files",
      "List files and directories. The path must be relative to the working directory and cannot escape it.",
      { path: { type: "string", description: "Directory path relative to the working directory. Defaults to '.'." } },
      [],
    ),
  ];
  if (access !== "plan") {
    tools.push(
      toolSchema(
        "write_file",
        "Write a UTF-8 text file, creating parent directories as needed. The path must be relative to the working directory and cannot escape it.",
        {
          path: { type: "string", description: "Path relative to the working directory." },
          content: { type: "string", description: "Full file contents to write." },
        },
        ["path", "content"],
      ),
    );
  }
  return tools;
}

function parseToolArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`Invalid tool arguments JSON: ${raw}`);
  }
}

async function executeTool(name, rawArgs, cwd) {
  const args = parseToolArgs(rawArgs);
  if (name === "read_file") {
    const filePath = resolveInsideCwd(args.path, cwd);
    return await readFile(filePath, "utf8");
  }
  if (name === "list_files") {
    const dirPath = resolveInsideCwd(typeof args.path === "string" && args.path.trim() ? args.path : ".", cwd);
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))
      .join("\n");
  }
  if (name === "write_file") {
    if (typeof args.content !== "string") {
      throw new Error("write_file requires a content string");
    }
    const filePath = resolveInsideCwd(args.path, cwd);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf8");
    return `Wrote ${args.path}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

function toolName(call) {
  return call?.function?.name || call?.name || "";
}

function toolCallId(call, index) {
  return call?.id || call?.tool_call_id || `tool_${index}`;
}

function toolArguments(call) {
  return call?.function?.arguments ?? call?.arguments ?? {};
}

async function chatCompletions(baseUrl, apiKey, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(`Failed to reach Ark API at ${baseUrl}/chat/completions: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    fail(`Ark API error ${response.status}: ${raw || response.statusText}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`Ark API returned non-JSON response: ${raw}`);
  }
}

async function main() {
  const apiKey = env("ARK_API_KEY");
  if (!apiKey) {
    fail(
      "ARK_API_KEY is missing. Set it in the Studio secrets store (default name ARK_API_KEY) or export ARK_API_KEY / DOUBAO_API_KEY.",
    );
  }
  const baseUrl = (env("ARK_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = env("ARK_MODEL") || DEFAULT_MODEL;
  const access = env("AUTOLOOP_ACCESS") || "acceptEdits";
  const prompt = process.env.AUTOLOOP_PROMPT ?? "";
  const cwd = process.cwd();
  const tools = toolsForAccess(access);
  const messages = [{ role: "user", content: prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const data = await chatCompletions(baseUrl, apiKey, { model, messages, tools });
    addUsage(usage, data?.usage);
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    const message = choice?.message;
    if (!message || typeof message !== "object") {
      fail("Ark API response did not include an assistant message.");
    }
    messages.push(message);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      process.stdout.write(`${JSON.stringify({ finalText: textFromContent(message.content), usage })}\n`);
      return;
    }
    for (const [index, call] of toolCalls.entries()) {
      const name = toolName(call);
      let content;
      try {
        if (name === "write_file" && access === "plan") {
          throw new Error("write_file is not available in plan mode");
        }
        content = await executeTool(name, toolArguments(call), cwd);
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCallId(call, index),
        content,
      });
    }
  }

  fail(`Doubao did not return a final assistant message after ${MAX_TURNS} turns.`);
}

await main();
