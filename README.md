# AutoLoop Studio

本机自动化中台：照搬 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 的纯决策内核（SQLite 事件溯源、挂起零消耗、跳数熔断），并补齐可在浏览器里配置规则、密钥、通道和拍板卡片的 Web 控制台。

需要 **Node.js >= 24**。`packages/*` 零外部运行时依赖。

## 启动

先构建前端，再一键拉起 Hub（同时托管 API、静态控制台、本机 Worker 和通知通道）：

```bash
npm --prefix apps/web install
npm run build:web
npm start
# 或：node packages/host/cli.ts up [--host 127.0.0.1] [--port 3350] [--data-dir ~/.autoloop-studio]
```

打开 http://127.0.0.1:3350/ 即可使用配置台。API 仍在 `/v1/*` 和 `/healthz`。

本地前后端分离开发：

```bash
npm run dev:hub    # 后端，默认 127.0.0.1:3350
npm run dev:web    # Vite，127.0.0.1:5173，已代理 /v1 与 /healthz
```

数据目录默认 `~/.autoloop-studio`（`hub.db`、`config.json`、`rules.json`、`secrets.env`）。

## Worker 结果恢复

Worker 在上报前将执行结果写入状态目录的 `results.sqlite`。网络中断、超时及服务端暂时不可用时，Worker 退避重试，最长间隔 15 秒。结果等待确认期间占用一个 Worker 并发名额。收到 Hub 的成功确认后才删除本地回执。

重启时使用原 Worker 状态目录和相同的 Hub URL，待确认结果会自动补报。Hub 需要保留原数据目录。HTTP 400、404、409、422 拒绝的结果留在 `results` 表，可按 `rejection IS NOT NULL` 查看原因。外部业务操作成功而 Worker 尚未保存结果时发生的崩溃，仍需业务系统用幂等键或对账处理。

## 测试

```bash
npm run test          # core + worker + plugins + e2e
npm run test:core
npm run test:worker
npm run test:plugins
npm run test:e2e
node --test tests/result-recovery.test.ts  # 单独验证断网、确认丢失和进程重启
```

## 目录

```
apps/web/                  React + Vite 配置控制台
packages/protocol/         共享类型、校验、HTTP 客户端
packages/kernel/           纯决策状态机与事件投影
packages/host/             HTTP+SSE Hub、CLI `up`、静态资源与插件组装
packages/worker/           长轮询领活、进程隔离、回执修复
packages/plugins/agents/   Claude / Codex / Cursor / command 适配器
packages/plugins/sources/  GitHub / GitLab / 通用 Webhook 来源
packages/plugins/channels/ 桌面 / 飞书 / Webhook 通道与 dispatcher
tests/                     端到端集成测试
```
