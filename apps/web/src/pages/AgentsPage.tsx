import { Save } from "lucide-react";
import { useConfigDraft } from "../hooks/useConfigDraft";
import { AGENT_ACCESS, type AppConfig } from "../types";
import { Field } from "../components/ui";

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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {dirty ? (
            <span className="pill">
              <span className="dirty-dot" /> 有未保存更改
            </span>
          ) : null}
          <button className="btn" disabled={!dirty} onClick={reset}>
            重置
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Save size={15} />
            保存配置
          </button>
        </div>
      </div>

      <section className="panel">
        <h3>Agents</h3>
        <div className="form-grid">
          <Field label="Claude">
            <label className="check">
              <input
                type="checkbox"
                checked={claude.enabled}
                onChange={(event) => patchAgents({ claude: { ...claude, enabled: event.target.checked } })}
              />
              启用
            </label>
          </Field>
          <Field label="Claude bin（可选）">
            <input
              value={claude.bin ?? ""}
              placeholder="claude"
              onChange={(event) => patchAgents({ claude: { ...claude, bin: event.target.value || undefined } })}
            />
          </Field>
          <Field label="Claude defaultAccess" className="span-2">
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
          <Field label="Codex">
            <label className="check">
              <input
                type="checkbox"
                checked={codex.enabled}
                onChange={(event) => patchAgents({ codex: { ...codex, enabled: event.target.checked } })}
              />
              启用
            </label>
          </Field>
          <Field label="Codex bin（可选）">
            <input
              value={codex.bin ?? ""}
              placeholder="codex"
              onChange={(event) => patchAgents({ codex: { ...codex, bin: event.target.value || undefined } })}
            />
          </Field>
          <Field label="Cursor">
            <label className="check">
              <input
                type="checkbox"
                checked={cursor.enabled}
                onChange={(event) => patchAgents({ cursor: { ...cursor, enabled: event.target.checked } })}
              />
              启用
            </label>
          </Field>
          <Field label="Cursor bin（可选）">
            <input
              value={cursor.bin ?? ""}
              placeholder="agent"
              onChange={(event) => patchAgents({ cursor: { ...cursor, bin: event.target.value || undefined } })}
            />
          </Field>
          <Field label="Command 适配器" className="span-2">
            <label className="check">
              <input
                type="checkbox"
                checked={command.enabled}
                onChange={(event) => patchAgents({ command: { enabled: event.target.checked } })}
              />
              启用本地 command 适配器
            </label>
          </Field>
        </div>
      </section>

      <section className="panel">
        <h3>豆包 / Doubao</h3>
        <p className="muted">通过火山方舟 OpenAI 兼容 API 调用豆包模型。API Key 从 Secrets 中按名称读取，也可回退到环境变量 ARK_API_KEY / DOUBAO_API_KEY。</p>
        <div className="form-grid">
          <Field label="启用">
            <label className="check">
              <input
                type="checkbox"
                checked={doubao.enabled}
                onChange={(event) => patchAgents({ doubao: { ...doubao, enabled: event.target.checked } })}
              />
              启用豆包适配器
            </label>
          </Field>
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
          <Field label="API Key Secret 名称">
            <input
              value={doubao.apiKeySecret ?? ""}
              placeholder="ARK_API_KEY"
              onChange={(event) =>
                patchAgents({ doubao: { ...doubao, apiKeySecret: event.target.value || undefined } })
              }
            />
          </Field>
        </div>
      </section>

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
            <label className="check">
              <input
                type="checkbox"
                checked={draft.worker.enabled}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, worker: { ...current.worker, enabled: event.target.checked } }))
                }
              />
              enabled
            </label>
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
    </div>
  );
}
