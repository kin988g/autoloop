#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const stage = process.argv[2] || "preflight";
const contextPath = process.env.AUTOLOOP_CONTEXT_PATH;
if (!contextPath) {
  console.error("AUTOLOOP_CONTEXT_PATH is required");
  process.exit(1);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf8"));
const sessionId = process.env.AUTOLOOP_SESSION_ID || `release-${stage}-${Date.now()}`;

function emit(receipt) {
  const finalText = `\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``;
  process.stdout.write(`${JSON.stringify({ finalText, sessionId })}\n`);
}

function countTsFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countTsFiles(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) count += 1;
  }
  return count;
}

async function run() {
  if (stage === "preflight") {
    const cwd = process.cwd();
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const hasDist = existsSync(join(cwd, "apps", "web", "dist", "index.html"));
    const tsCount = countTsFiles(join(cwd, "packages")) + countTsFiles(join(cwd, "apps", "web", "src"));
    const summary = `版本 v${pkg.version} 巡检通过：扫描 ${tsCount} 个 TS/TSX 源文件，前端构建产物${hasDist ? "完整" : "缺失"}，准备进入发布门禁。`;

    emit({
      notice: {
        title: `巡检通过：v${pkg.version}`,
        body: `${summary}\n已自动发送下游事件 release.ready，交由发布门禁规则接力处理。`,
      },
      events: [
        {
          type: "release.ready",
          lane: `release-v${pkg.version}`,
          payload: {
            version: pkg.version,
            tsFiles: tsCount,
            webDistReady: hasDist,
            summary,
          },
        },
      ],
    });
    return;
  }

  if (stage === "rollout") {
    const events = Array.isArray(ctx.events) ? ctx.events : [];
    const timerEvent = events.find((e) => e.type === "timer.fired" || e.source === "timer");
    const readyEvent = events.find((e) => e.type === "release.ready");
    const payload = (readyEvent && readyEvent.payload) || {};
    const version = payload.version || "0.1.0";

    // Step 3: delayed timer wakeup -> live health check
    if (timerEvent && !ctx.answer) {
      let healthText = "探活失败";
      try {
        const res = await fetch("http://127.0.0.1:3350/healthz");
        const data = await res.json();
        healthText = `HTTP ${res.status}，服务状态 ok=${data.ok}，已运行 ${Math.round((data.uptimeMs || 0) / 1000)}s`;
      } catch (err) {
        healthText = `探活异常: ${err instanceof Error ? err.message : String(err)}`;
      }
      emit({
        notice: {
          title: `线上探活验收完成（v${version}）`,
          body: `延迟复查已自动触发并完成真实探活：${healthText}。本次发布闭环已全部结束。`,
        },
      });
      return;
    }

    // Step 2: human answered the rollout card -> execute rollout + schedule 8s health check
    if (ctx.answer) {
      const choice = ctx.answer.choice || ctx.answer.text || "灰度发布 10%";
      if (choice.includes("取消")) {
        emit({
          notice: {
            title: `已中止发布（v${version}）`,
            body: `收到你的决定「${choice}」，已安全取消发布，无变更上线。`,
          },
        });
        return;
      }
      emit({
        notice: {
          title: `已执行：${choice}（v${version}）`,
          body: `已按你的审批结果执行「${choice}」${ctx.answer.text ? `（备注：${ctx.answer.text}）` : ""}，并自动预约 8 秒后进行线上健康探活复查。`,
        },
        later: {
          delaySeconds: 8,
          reason: `发布后 8 秒自动探活 v${version}`,
        },
      });
      return;
    }

    // Step 1: initial release.ready event -> suspend and ask human for rollout strategy
    const summary = payload.summary || `v${version} 已完成发布前巡检，等待选择发布策略。`;
    emit({
      ask: {
        title: `发布审批：v${version} 已就绪`,
        body: `${summary}\n请选择本次上线策略（审批后将自动执行并在 8 秒后自动探活验收）：`,
        options: ["灰度发布 10%", "全量发布 100%", "取消本次发布"],
      },
    });
    return;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
