import type { ReactNode } from "react";
import { Bot, Cloud, Save, Sparkles, SquareTerminal, WandSparkles } from "lucide-react";
import { useConfigDraft } from "../hooks/useConfigDraft";
import { AGENT_ACCESS, type AppConfig } from "../types";
import { Field, SaveBar, Toggle } from "../components/ui";

export function AgentsPage() {
  const { draft, dirty, setDraft, reset, save } = useConfigDraft();
  const agents = draft.agents;
  const claude = agents.claude ?? { enabled: false };
  const codex = agents.codex ?? { enabled: false };
  const cursor = agents.cursor ?? { enabled: false };
  const command = agents.command ?? { enabled: false };
  const doubao = agents.doubao ?? {
    enabled: false,
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6-250615",
    apiKeySecret: "ARK_API_KEY",
  };

  const patchAgents = (patch: Partial<AppConfig["agents"]>) => {
    setDraft((current) => ({ ...current, agents: { ...current.agents, ...patch } }));
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Agent 与参数</h2>
          <p>配置 Claude / Codex / Cursor / Command / 豆包 适配器，以及 Hub 与 Worker 运行参数。</p>
        </div>
        <div className="page-header-actions">
          {dirty ? (
            <span className="pill">
              <span className="dirty-dot" /> 有未保存更改
            </span>
          ) : null}
          <button className="btn" disabled={!dirty} onClick={reset}>
            重置
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Save size={15} strokeWidth={1.75} />
            保存配置
          </button>
        </div>
      </div>

      <div className="agent-grid">
        <AgentCard
          tone="claude"
          title="Claude"
          subtitle="Anthropic Claude CLI 适配器"
          icon={<WandSparkles size={16} strokeWidth={1.75} />}
          enabled={claude.enabled}
          onToggle={(enabled) => patchAgents({ claude: { ...claude, enabled } })}
        >
          <Field label="Claude bin（可选）">
            <input
              value={claude.bin ?? ""}
              placeholder="claude"
              onChange={(event) => patchAgents({ claude: { ...claude, bin: event.target.value || undefined } })}
            />
          </Field>
          <Field label="Claude defaultAccess">
            <select
              value={claude.defaultAccess ?? ""}
              onChange={(event) => patchAgents({ claude: { ...claude, defaultAccess: event.target.value || undefined } })}
            >
              <option value="">（未指定）</option>
              {AGENT_ACCESS.map((access) => (
                <option key={access} value={access}>
                  {access}
                </option>
              ))}
            </select>
          </Field>
        </AgentCard>

        <AgentCard
          tone="codex"
          title="Codex"
          subtitle="OpenAI Codex CLI 适配器"
          icon={<Sparkles size={16} strokeWidth={1.75} />}
          enabled={codex.enabled}
          onToggle={(enabled) => patchAgents({ codex: { ...codex, enabled } })}
        >
          <Field label="Codex bin（可选）" className="span-2">
            <input
              value={codex.bin ?? ""}
              placeholder="codex"
              onChange={(event) => patchAgents({ codex: { ...codex, bin: event.target.value || undefined } })}
            />
          </Field>
        </AgentCard>

        <AgentCard
          tone="cursor"
          title="Cursor"
          subtitle="本机 Cursor Agent CLI"
          icon={<Bot size={16} strokeWidth={1.75} />}
          enabled={cursor.enabled}
          onToggle={(enabled) => patchAgents({ cursor: { ...cursor, enabled } })}
        >
          <Field label="Cursor bin（可选）" className="span-2">
            <input
              value={cursor.bin ?? ""}
              placeholder="agent"
              onChange={(event) => patchAgents({ cursor: { ...cursor, bin: event.target.value || undefined } })}
            />
          </Field>
        </AgentCard>

        <AgentCard
          tone="doubao"
          title="豆包 / Doubao"
          subtitle="火山方舟 OpenAI 兼容 API"
          icon={<Cloud size={16} strokeWidth={1.75} />}
          enabled={doubao.enabled}
          onToggle={(enabled) => patchAgents({ doubao: { ...doubao, enabled } })}
        >
          <p className="muted" style={{ margin: "-4px 0 10px", gridColumn: "1 / -1" }}>
            API Key 从 Secrets 中按名称读取，也可回退到环境变量 ARK_API_KEY / DOUBAO_API_KEY。
          </p>
          <Field label="Base URL">
            <input
              value={doubao.baseUrl ?? ""}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              onChange={(event) =>
                patchAgents({ doubao: { ...doubao, baseUrl: event.target.value || undefined } })
              }
            />
          </Field>
          <Field label="默认模型 / Endpoint ID">
            <input
              value={doubao.model ?? ""}
              placeholder="doubao-seed-1-6-250615"
              onChange={(event) =>
                patchAgents({ doubao: { ...doubao, model: event.target.value || undefined } })
              }
            />
          </Field>
          <Field label="API Key Secret 名称" className="span-2">
            <input
              value={doubao.apiKeySecret ?? ""}
              placeholder="ARK_API_KEY"
              onChange={(event) =>
                patchAgents({ doubao: { ...doubao, apiKeySecret: event.target.value || undefined } })
              }
            />
          </Field>
        </AgentCard>

        <AgentCard
          tone="command"
          title="Command"
          subtitle="本地命令行适配器"
          icon={<SquareTerminal size={16} strokeWidth={1.75} />}
          enabled={command.enabled}
          onToggle={(enabled) => patchAgents({ command: { enabled } })}
        >
          <p className="muted" style={{ margin: "0 0 8px" }}>
            启用后，规则可将 adapter 设为 command，直接执行本机命令并把 {"{prompt}"} 替换为规则指令。
          </p>
        </AgentCard>
      </div>

      <section className="panel">
        <h3>Hub</h3>
        <div className="form-grid">
          <Field label="host">
            <input
              value={draft.hub.host}
              onChange={(event) => setDraft((current) => ({ ...current, hub: { ...current.hub, host: event.target.value } }))}
            />
          </Field>
          <Field label="port">
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.hub.port}
              onChange={(event) =>
                setDraft((current) => ({ ...current, hub: { ...current.hub, port: Number(event.target.value) || current.hub.port } }))
              }
            />
          </Field>
          <Field label="publicUrl（可选，卡片外链）">
            <input
              type="url"
              value={draft.hub.publicUrl ?? ""}
              placeholder="https://example.local"
              onChange={(event) =>
                setDraft((current) => ({ ...current, hub: { ...current.hub, publicUrl: event.target.value || undefined } }))
              }
            />
          </Field>
          <Field label="timezone">
            <input
              value={draft.hub.timezone}
              placeholder="Asia/Shanghai"
              onChange={(event) => setDraft((current) => ({ ...current, hub: { ...current.hub, timezone: event.target.value } }))}
            />
          </Field>
        </div>
      </section>

      <section className="panel">
        <h3>Worker</h3>
        <div className="form-grid">
          <Field label="启用">
            <Toggle
              checked={draft.worker.enabled}
              onChange={(enabled) => setDraft((current) => ({ ...current, worker: { ...current.worker, enabled } }))}
              label="enabled"
            />
          </Field>
          <Field label="name">
            <input
              value={draft.worker.name}
              onChange={(event) => setDraft((current) => ({ ...current, worker: { ...current.worker, name: event.target.value } }))}
            />
          </Field>
          <Field label="capacity" hint="默认 2">
            <input
              type="number"
              min={1}
              value={draft.worker.capacity}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  worker: { ...current.worker, capacity: Number(event.target.value) || current.worker.capacity },
                }))
              }
            />
          </Field>
          <Field label="pollTimeoutMs" hint="默认 30000">
            <input
              type="number"
              min={0}
              value={draft.worker.pollTimeoutMs}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  worker: { ...current.worker, pollTimeoutMs: Number(event.target.value) || 0 },
                }))
              }
            />
          </Field>
        </div>
      </section>

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void save()} saveLabel="保存配置" />
    </div>
  );
}

function AgentCard({
  tone,
  title,
  subtitle,
  icon,
  enabled,
  onToggle,
  children,
}: {
  tone: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <section className="agent-card">
      <div className="agent-card-head">
        <div className="agent-card-title">
          <span className={`agent-icon ${tone}`}>{icon}</span>
          <div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
        </div>
        <Toggle checked={enabled} onChange={onToggle} ariaLabel={`启用 ${title}`} />
      </div>
      {children ? <div className="form-grid">{children}</div> : null}
    </section>
  );
}
