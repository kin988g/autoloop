# AutoLoop Studio — Shared Architecture & API Contract (v0.1)

Inspired by `KKKKhazix/agent-autoloop`: zero-external-runtime-dependency Node >= 24 + `node:sqlite` event-sourced core, plus a React + Vite frontend configuration & approval console.

## 1. Directory Ownership (Strict — Do Not Edit Other Bots' Directories)
- **Bot 1 (AutoLoop-内核协议)**: `packages/protocol/`, `packages/kernel/`, `packages/host/`
- **Bot 2 (AutoLoop-前端配置台)**: `apps/web/`
- **Bot 3 (AutoLoop-接单适配)**: `packages/worker/`, `packages/plugins/agents/`
- **Bot 4 (AutoLoop-来源通道)**: `packages/plugins/sources/`, `packages/plugins/channels/`
- **Main Coordinator (988)**: root `package.json`, `tsconfig.json`, `CONTRACT.md`, integration & E2E verification.

## 2. Core Principles (Inherited from agent-autoloop)
1. **Zero external runtime dependencies** in `packages/*` (only Node >= 24 built-ins: `node:sqlite`, `node:http`, `node:crypto`, `node:fs`, `node:path`, `node:child_process`, `node:test`, `fetch`).
2. **Pure deterministic kernel** (`packages/kernel/`): no `Date.now()`, no `Math.random()`, no network, no product names; `decide(view, input, now)` returns facts to append.
3. **Event sourcing on SQLite WAL**: append-only `fact_log` + transactional projections (`events`, `runs`, `cards`, `deliveries`, `timers`, `pauses`, `keys`).
4. **Zero-token suspend**: when an Agent outputs `ask`, the run finishes and process exits; state persists in SQLite until the human answers the card, then a new run resumes the same `sessionId`.
5. **Instruction / data separation**: untrusted external event payloads go into `context.json` (never concatenated into system prompt); `cwd`, `agent`, `access` come strictly from `rules.json`.
6. **Hop circuit breaker**: `hops` increments on follow-up/emitted events (max 8); above 8, record without dispatching and create a notice card.
7. **Node >= 24 native TS execution**: use `erasableSyntaxOnly` (no `enum`, no parameter properties, explicit `.ts` extensions in relative imports).

## 3. Data Shapes (JSON)

### Rule (`rules.json`: `{ "rules": Rule[] }`)
```ts
export interface Rule {
  name: string;
  enabled: boolean;
  description?: string;
  trigger: {
    type: "cron" | "webhook" | "manual" | "event";
    cron?: string;           // 5-field cron, e.g. "0 9 * * *"
    timezone?: string;       // e.g. "Asia/Shanghai"
    source?: string;         // e.g. "github", "gitlab", "custom"
    eventType?: string;      // e.g. "issue.opened"
  };
  agent: {
    adapter: "claude" | "codex" | "cursor" | "command" | "doubao";
    cwd: string;
    access: "plan" | "acceptEdits" | "bypassPermissions";
    prompt: string;          // System/task instruction (trusted, local)
    command?: string[];      // Only when adapter === "command", with "{prompt}" placeholder
    timeoutMinutes?: number; // Default 180
    model?: string;          // Optional model id (Cursor --model, Doubao ARK_MODEL)
  };
  channels: string[];        // e.g. ["web", "desktop", "feishu"]
  laneKey?: string;          // Optional payload field for grouping runs
  paused?: boolean;
}
```

### AppConfig (`config.json`)
```ts
export interface AppConfig {
  hub: {
    host: string;            // Default "127.0.0.1"
    port: number;            // Default 3350
    publicUrl?: string;      // Optional public base URL for card links
    timezone: string;        // Default "Asia/Shanghai"
  };
  worker: {
    enabled: boolean;
    name: string;
    capacity: number;        // Default 2
    pollTimeoutMs: number;   // Default 30000
  };
  agents: {
    claude?: { enabled: boolean; bin?: string; defaultAccess?: string };
    codex?: { enabled: boolean; bin?: string };
    cursor?: { enabled: boolean; bin?: string };
    command?: { enabled: boolean };
    doubao?: { enabled: boolean; baseUrl?: string; model?: string; apiKeySecret?: string };
  };
  channels: {
    web: { enabled: boolean };
    desktop: { enabled: boolean };
    feishu?: { enabled: boolean; webhookUrlSecret?: string; appId?: string; appSecretKey?: string };
    webhook?: { enabled: boolean; preset?: "dingtalk" | "wecom" | "slack" | "discord" | "custom"; urlSecret?: string };
  };
  sources: {
    github?: { enabled: boolean; webhookSecretKey?: string };
    gitlab?: { enabled: boolean; webhookSecretKey?: string };
  };
}
```

### Receipt (fenced ```` ```agent-autoloop ```` JSON block in Agent's final message)
```ts
export interface Receipt {
  ask?: { title: string; body: string; options?: string[] };
  notice?: { title: string; body: string };
  resolve?: { cardId: string; summary?: string };
  later?: { delaySeconds: number; reason: string };
  events?: Array<{ type: string; lane?: string; payload: Record<string, unknown> }>;
}
```

### Job (returned by `GET /v1/work`)
```ts
export interface Job {
  runId: string;
  attempt: number;
  runToken: string;
  rule: Rule;
  lane: string;
  sessionId?: string;
  context: {
    events: Array<{ id: string; type: string; source: string; payload: unknown; createdAt: number }>;
    answer?: { cardId: string; choice?: string; text?: string; answeredAt: number };
    openCards: Array<{ id: string; title: string; body: string }>;
  };
}
```

### Card
```ts
export interface Card {
  id: string;
  runId: string;
  ruleName: string;
  lane: string;
  kind: "ask" | "notice";
  status: "open" | "decided" | "done" | "closed";
  title: string;
  body: string;
  options?: string[];
  answer?: { choice?: string; text?: string; responder?: string; answeredAt: number };
  createdAt: number;
  updatedAt: number;
}
```

## 4. HTTP + JSON API (Hub on `http://127.0.0.1:3350`)
CORS headers (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`) MUST be enabled for local Vite dev (`http://127.0.0.1:5173`).
In local dev mode, if `Authorization: Bearer <key>` is omitted on loopback, `owner` access is allowed by default unless `AUTOLOOP_REQUIRE_AUTH=1`.

### Runtime Endpoints
- `GET /healthz` -> `{ ok: true, version: "0.1.0", uptimeMs: number }`
- `POST /v1/events` -> body `{ type, source, lane?, payload?, dedupeKey?, hops? }` -> `{ eventId, runId?, queued: boolean, circuitBroken?: boolean }`
- `POST /v1/in/:source` -> webhook endpoint (raw body + headers passed to source adapter)
- `GET /v1/work?worker=<name>&capacity=<n>&running=<csv>&wait=<ms>` -> `200 { job: Job | null }`
- `POST /v1/runs/:id/started` -> `{ ok: true }`
- `POST /v1/runs/:id/result` -> body `{ outcome: "done"|"nothing"|"failed"|"cancelled", sessionId?, receipt?, error?, usage? }` -> `{ ok: true, cardId? }`
- `POST /v1/runs/:id/cancel` -> `{ ok: true }`
- `GET /v1/runs?rule=&status=&limit=` -> `{ runs: RunRecord[] }`
- `GET /v1/cards?status=open|decided|done|closed|all` -> `{ cards: Card[] }`
- `GET /v1/cards/next?channel=<name>&wait=<ms>` -> `{ delivery: { id, cardId, channel, card: Card } | null }`
- `POST /v1/cards/:id/delivered` -> body `{ channel, externalId? }` -> `{ ok: true }`
- `POST /v1/cards/:id/failed` -> body `{ channel, error }` -> `{ ok: true }`
- `POST /v1/cards/:id/answer` -> body `{ choice?, text?, responder? }` -> `{ ok: true, resumedRunId? }`
- `POST /v1/cards/:id/resolve` -> body `{ summary? }` -> `{ ok: true }`
- `GET /v1/state` -> `{ config, rules, runs, cards, workers, stats: { totalRuns, activeRuns, openCards, totalEvents } }`
- `GET /v1/stream` -> SSE (`Content-Type: text/event-stream`), pushes `event: update\ndata: {"type": "...", "at": ...}\n\n`

### Frontend Configuration Endpoints
- `GET /v1/config` -> `{ config: AppConfig }`
- `PUT /v1/config` -> body `AppConfig` -> `{ ok: true, config: AppConfig }` (validates & persists `config.json`)
- `GET /v1/rules` -> `{ rules: Rule[], error?: string }`
- `PUT /v1/rules` -> body `{ rules: Rule[] }` -> `{ ok: true, rules: Rule[] }` (validates & persists `rules.json`, reloads cron)
- `POST /v1/rules/:name/pause` | `resume` | `run` -> `{ ok: true, runId? }`
- `GET /v1/secrets` -> `{ keys: Array<{ name: string; configured: boolean }> }` (NEVER return raw values)
- `PUT /v1/secrets` -> body `{ set?: Record<string, string>, unset?: string[] }` -> `{ ok: true, keys: ... }`

## 5. Plugin Interfaces
- **Agent Adapter** (`packages/plugins/agents/types.ts`):
  `interface AgentAdapter { name: string; buildCommand(job: Job, prompt: string, contextPath: string): { bin: string; args: string[]; env?: Record<string, string> }; parseOutput(stdout: string, stderr: string): { finalText: string; sessionId?: string; usage?: Record<string, number> }; }`
- **Source Adapter** (`packages/plugins/sources/types.ts`):
  `interface SourceAdapter { name: string; verifyAndParse(headers: Record<string, string>, rawBody: string, secret?: string): { ok: true; events: Array<{ type: string; lane?: string; dedupeKey?: string; payload: Record<string, unknown> }> } | { ok: false; status: number; error: string }; }`
- **Channel Adapter** (`packages/plugins/channels/types.ts`):
  `interface ChannelAdapter { name: string; sendCard(card: Card, config: AppConfig, secrets: Record<string, string>): Promise<{ ok: boolean; externalId?: string; error?: string }>; }`
