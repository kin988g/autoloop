#!/usr/bin/env node
import { readFileSync } from "node:fs";

const contextPath = process.env.AUTOLOOP_CONTEXT_PATH;
if (!contextPath) {
  console.error("AUTOLOOP_CONTEXT_PATH is required");
  process.exit(1);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf8"));
const sessionId = process.env.AUTOLOOP_SESSION_ID || "e2e-session";

function emit(receipt) {
  const finalText = `\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``;
  process.stdout.write(`${JSON.stringify({ finalText, sessionId })}\n`);
}

if (ctx.answer) {
  emit({
    notice: {
      title: "Completed",
      body: `choice=${ctx.answer.choice ?? ""} text=${ctx.answer.text ?? ""}`,
    },
  });
} else {
  emit({
    ask: {
      title: "Approve deploy?",
      body: "Proceed with the change?",
      options: ["yes", "no"],
    },
  });
}
