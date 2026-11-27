import { useEffect, useMemo, useState } from "react";
import { Copy, Pause, Play, Plus, Save, Trash2 } from "lucide-react";
import { api, ApiError } from "../api";
import { useHub } from "../context";
import { adapterLabel, triggerLabel } from "../format";
import {
  AGENT_ACCESS,
  AGENT_ADAPTERS,
  CHANNEL_PRESETS,
  CRON_PRESETS,
  cloneRules,
  emptyRule,
  type Rule,
  type TriggerType,
} from "../types";
import { Empty, Field, SaveBar, StatusChip, Toggle } from "../components/ui";

export function RulesPage() {
  const { rules: serverRules, toast, refresh, applyStateRules } = useHub();
  const [drafts, setDrafts] = useState<Rule[]>(() => cloneRules(serverRules));
  const [selectedName, setSelectedName] = useState<string | null>(serverRules[0]?.name ?? null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [baseline, setBaseline] = useState(() => JSON.stringify(serverRules));

  useEffect(() => {
    const next = JSON.stringify(serverRules);
    if (next === baseline) return;
    if (JSON.stringify(drafts) === baseline) {
      setDrafts(cloneRules(serverRules));
      setBaseline(next);
      if (selectedName && !serverRules.some((rule) => rule.name === selectedName)) {
        setSelectedName(serverRules[0]?.name ?? null);
      }
    }
  }, [serverRules, baseline, drafts, selectedName]);

  const dirty = JSON.stringify(drafts) !== baseline;
  const selected = drafts.find((rule) => rule.name === selectedName) ?? null;
  const visible = drafts.filter((rule) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${rule.name} ${rule.description ?? ""} ${rule.trigger.type}`.toLowerCase().includes(q);
  });

  const setSelected = (updater: (rule: Rule) => Rule) => {
    if (!selected) return;
    setDrafts((prev) => prev.map((rule) => (rule.name === selected.name ? updater(rule) : rule)));
  };

  const renameSelected = (nextName: string) => {
    if (!selected) return;
    const previous = selected.name;
    setDrafts((prev) => prev.map((rule) => (rule.name === previous ? { ...rule, name: nextName } : rule)));
    setSelectedName(nextName);
  };

  const validate = (list: Rule[]): string | null => {
    if (list.length === 0) return null;
    const names = new Set<string>();
    for (const rule of list) {
      const name = rule.name.trim();
      if (!name) return "规则名称不能为空";
      if (names.has(name)) return `规则名称重复：${name}`;
      names.add(name);
      if (!rule.trigger?.type) return `${name}: 请选择触发类型`;
      if (rule.trigger.type === "cron") {
        if (!rule.trigger.cron?.trim()) return `${name}: cron 表达式不能为空`;
        if (rule.trigger.cron.trim().split(/\s+/).length !== 5) return `${name}: cron 需要 5 段，例如 0 9 * * *`;
      }
      if (rule.trigger.type === "webhook" && !rule.trigger.source?.trim()) return `${name}: webhook 需要填写 source`;
      if (rule.trigger.type === "event" && !rule.trigger.eventType?.trim()) return `${name}: event 需要填写 eventType`;
      if (!rule.agent?.cwd?.trim()) return `${name}: 工作目录 cwd 不能为空`;
      if (!rule.agent?.prompt?.trim()) return `${name}: prompt 不能为空`;
      if (rule.agent.adapter === "command" && (!rule.agent.command || rule.agent.command.length === 0)) {
        return `${name}: command 适配器需要至少一条命令参数`;
      }
      if (rule.agent.timeoutMinutes !== undefined && rule.agent.timeoutMinutes <= 0) {
        return `${name}: timeoutMinutes 必须大于 0`;
      }
    }
    return null;
  };

  const save = async (list = drafts) => {
    const error = validate(list);
    if (error) {
      toast({ kind: "error", title: "校验未通过", detail: error });
      return;
    }
    setSaving(true);
    try {
      const result = await api.putRules(list);
      const saved = result.rules.length > 0 ? result.rules : list;
      setDrafts(cloneRules(saved));
      setBaseline(JSON.stringify(saved));
      applyStateRules(saved);
      toast({ kind: "ok", title: "规则已保存", detail: `共 ${saved.length} 条` });
      await refresh();
    } catch (error) {
      toast({ kind: "error", title: "保存失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setSaving(false);
    }
  };

  const addRule = () => {
    let idx = drafts.length + 1;
    let name = `new-rule-${idx}`;
    const existing = new Set(drafts.map((rule) => rule.name));
    while (existing.has(name)) {
      idx += 1;
      name = `new-rule-${idx}`;
    }
    const next = emptyRule({ name });
    setDrafts((prev) => [...prev, next]);
    setSelectedName(name);
    setJsonMode(false);
  };

  const duplicate = (rule: Rule) => {
    let idx = 2;
    let name = `${rule.name}-copy`;
    const existing = new Set(drafts.map((item) => item.name));
    while (existing.has(name)) {
      name = `${rule.name}-copy-${idx}`;
      idx += 1;
    }
    const copy = { ...structuredClone(rule), name };
    setDrafts((prev) => [...prev, copy]);
    setSelectedName(name);
  };

  const remove = (name: string) => {
    const next = drafts.filter((rule) => rule.name !== name);
    setDrafts(next);
    if (selectedName === name) setSelectedName(next[0]?.name ?? null);
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown }).rules;
      if (!Array.isArray(list)) throw new Error("JSON 需要是 Rule 数组或 { rules: Rule[] }");
      const rules = list.map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 条不是对象`);
        return emptyRule(item as Partial<Rule>);
      });
      const error = validate(rules);
      if (error) throw new Error(error);
      setDrafts(rules);
      setJsonError(null);
      setJsonMode(false);
      if (selectedName && !rules.some((rule) => rule.name === selectedName)) {
        setSelectedName(rules[0]?.name ?? null);
      }
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 无法解析");
    }
  };

  const openJson = () => {
    setJsonText(JSON.stringify({ rules: drafts }, null, 2));
    setJsonError(null);
    setJsonMode(true);
  };

  const resetDrafts = () => {
    setDrafts(cloneRules(serverRules));
    setBaseline(JSON.stringify(serverRules));
    setJsonMode(false);
  };

  const quickAction = async (kind: "pause" | "resume" | "run", name: string) => {
    if (dirty) {
      toast({ kind: "info", title: "请先保存未提交的规则修改，再执行暂停 / 恢复 / 立即运行" });
      return;
    }
    try {
      const result =
        kind === "pause" ? await api.pauseRule(name) : kind === "resume" ? await api.resumeRule(name) : await api.runRule(name);
      toast({
        kind: "ok",
        title: kind === "pause" ? "已暂停" : kind === "resume" ? "已恢复" : "已触发运行",
        detail: result.runId ? `runId=${result.runId}` : name,
      });
      await refresh();
    } catch (error) {
      toast({ kind: "error", title: "操作失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>规则编辑</h2>
          <p>可视化编辑 rules.json。保存时将完整提交 `PUT /v1/rules`。</p>
        </div>
        <div className="page-header-actions">
          {dirty ? (
            <span className="pill">
              <span className="dirty-dot" /> 有未保存更改
            </span>
          ) : null}
          <button className="btn" onClick={() => (jsonMode ? setJsonMode(false) : openJson())}>
            {jsonMode ? "返回表单" : "JSON 视图"}
          </button>
          <button className="btn" disabled={!dirty} onClick={resetDrafts}>
            重置
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            <Save size={15} strokeWidth={1.75} />
            保存全部规则
          </button>
        </div>
      </div>

      {jsonMode ? (
        <section className="panel">
          <Field label="rules.json" hint="保存前会在客户端校验。">
            <textarea className="json-view" value={jsonText} onChange={(event) => setJsonText(event.target.value)} />
          </Field>
          {jsonError ? <div className="banner">{jsonError}</div> : null}
          <div className="toolbar" style={{ marginBottom: 0, justifyContent: "flex-end" }}>
            <button className="btn" onClick={applyJson}>
              应用 JSON 到表单
            </button>
          </div>
        </section>
      ) : (
        <div className="master-detail">
          <section className="panel">
            <div className="toolbar">
              <input placeholder="搜索规则…" value={query} onChange={(event) => setQuery(event.target.value)} />
              <button className="btn sm primary" onClick={addRule}>
                <Plus size={14} strokeWidth={1.75} />
                新增
              </button>
            </div>
            {visible.length === 0 ? (
              <Empty>还没有规则，点击「新增」创建第一条。</Empty>
            ) : (
              <div className="rule-list">
                {visible.map((rule) => (
                  <button
                    key={rule.name || `draft-${rule.description}`}
                    className={`rule-item${selectedName === rule.name ? " selected" : ""}`}
                    onClick={() => setSelectedName(rule.name)}
                    type="button"
                  >
                    <div className="row">
                      <strong className="truncate">{rule.name || "(未命名)"}</strong>
                      <span className={`trigger-badge ${rule.trigger.type}`}>{triggerLabel(rule.trigger.type)}</span>
                    </div>
                    <div className="row">
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span className={`adapter-badge ${rule.agent.adapter}`}>{adapterLabel(rule.agent.adapter)}</span>
                        <StatusChip status={rule.enabled ? "enabled" : "disabled"} />
                        {rule.paused ? <StatusChip status="paused" /> : null}
                      </div>
                      <div style={{ display: "flex", gap: 4 }} onClick={(event) => event.stopPropagation()}>
                        {rule.paused ? (
                          <button className="btn icon sm" title="恢复" onClick={() => void quickAction("resume", rule.name)}>
                            <Play size={13} strokeWidth={1.75} />
                          </button>
                        ) : (
                          <button className="btn icon sm" title="暂停" onClick={() => void quickAction("pause", rule.name)}>
                            <Pause size={13} strokeWidth={1.75} />
                          </button>
                        )}
                        <button className="btn icon sm" title="立即运行" onClick={() => void quickAction("run", rule.name)}>
                          <Play size={13} strokeWidth={1.75} />
                        </button>
                        <button className="btn icon sm" title="复制" onClick={() => duplicate(rule)}>
                          <Copy size={13} strokeWidth={1.75} />
                        </button>
                        <button className="btn icon sm danger" title="删除" onClick={() => remove(rule.name)}>
                          <Trash2 size={13} strokeWidth={1.75} />
                        </button>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="card editor-card">
            {selected ? (
              <RuleForm
                rule={selected}
                allNames={drafts.map((rule) => rule.name)}
                onRename={renameSelected}
                onChange={setSelected}
              />
            ) : (
              <Empty>请选择左侧一条规则，或新建规则。</Empty>
            )}
          </section>
        </div>
      )}

      <SaveBar dirty={dirty} onReset={resetDrafts} onSave={() => void save()} saving={saving} saveLabel="保存全部规则" />
    </div>
  );
}

function RuleForm({
  rule,
  allNames,
  onRename,
  onChange,
}: {
  rule: Rule;
  allNames: string[];
  onRename: (name: string) => void;
  onChange: (updater: (rule: Rule) => Rule) => void;
}) {
  const [customChannel, setCustomChannel] = useState("");
  const nameClash = useMemo(() => {
    const name = rule.name.trim();
    return name.length > 0 && allNames.filter((item) => item === rule.name).length > 1;
  }, [allNames, rule.name]);

  const setTrigger = (type: TriggerType) => {
    onChange((current) => ({
      ...current,
      trigger: {
        ...current.trigger,
        type,
        cron: type === "cron" ? current.trigger.cron || "0 9 * * *" : current.trigger.cron,
      },
    }));
  };

  const toggleChannel = (name: string, checked: boolean) => {
    onChange((current) => {
      const next = new Set(current.channels);
      if (checked) next.add(name);
      else next.delete(name);
      return { ...current, channels: Array.from(next) };
    });
  };

  return (
    <>
      <div className="editor-section">
        <div className="section-title">基础信息</div>
        <div className="form-grid">
          <Field label="名称 name" hint={nameClash ? "名称与其他规则冲突" : "保存后将作为 API 路径标识"}>
            <input value={rule.name} onChange={(event) => onRename(event.target.value)} />
          </Field>
          <Field label="车道字段 laneKey（可选）">
            <input
              value={rule.laneKey ?? ""}
              onChange={(event) => onChange((current) => ({ ...current, laneKey: event.target.value || undefined }))}
            />
          </Field>
          <Field label="描述 description" className="span-2">
            <textarea
              style={{ minHeight: 64 }}
              value={rule.description ?? ""}
              onChange={(event) => onChange((current) => ({ ...current, description: event.target.value || undefined }))}
            />
          </Field>
        </div>
        <div className="check-row">
          <Toggle
            checked={rule.enabled}
            onChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
            label="启用 enabled"
          />
          <Toggle
            checked={Boolean(rule.paused)}
            onChange={(paused) => onChange((current) => ({ ...current, paused }))}
            label="暂停 paused"
          />
        </div>
      </div>

      <div className="editor-section">
        <div className="section-title">触发器</div>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {(["cron", "webhook", "manual", "event"] as TriggerType[]).map((type) => (
            <button key={type} className={`tab${rule.trigger.type === type ? " active" : ""}`} onClick={() => setTrigger(type)} type="button">
              {triggerLabel(type)}
            </button>
          ))}
        </div>
        {rule.trigger.type === "cron" ? (
          <div className="form-grid">
            <Field label="cron（5 段）" className="span-2">
              <input
                className="mono"
                value={rule.trigger.cron ?? ""}
                onChange={(event) => onChange((current) => ({ ...current, trigger: { ...current.trigger, cron: event.target.value } }))}
                placeholder="0 9 * * *"
              />
            </Field>
            <div className="span-2 option-row" style={{ marginBottom: 12 }}>
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.value + preset.label}
                  className={`option-btn${rule.trigger.cron === preset.value ? " selected" : ""}`}
                  type="button"
                  onClick={() => onChange((current) => ({ ...current, trigger: { ...current.trigger, cron: preset.value } }))}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Field label="timezone">
              <input
                value={rule.trigger.timezone ?? ""}
                placeholder="Asia/Shanghai"
                onChange={(event) =>
                  onChange((current) => ({ ...current, trigger: { ...current.trigger, timezone: event.target.value || undefined } }))
                }
              />
            </Field>
          </div>
        ) : null}
        {rule.trigger.type === "webhook" ? (
          <div className="form-grid">
            <Field label="source">
              <input
                value={rule.trigger.source ?? ""}
                placeholder="github / gitlab / custom"
                onChange={(event) =>
                  onChange((current) => ({ ...current, trigger: { ...current.trigger, source: event.target.value || undefined } }))
                }
              />
            </Field>
            <Field label="eventType（可选）">
              <input
                value={rule.trigger.eventType ?? ""}
                placeholder="issue.opened"
                onChange={(event) =>
                  onChange((current) => ({ ...current, trigger: { ...current.trigger, eventType: event.target.value || undefined } }))
                }
              />
            </Field>
          </div>
        ) : null}
        {rule.trigger.type === "event" ? (
          <Field label="eventType">
            <input
              value={rule.trigger.eventType ?? ""}
              placeholder="task.completed"
              onChange={(event) =>
                onChange((current) => ({ ...current, trigger: { ...current.trigger, eventType: event.target.value || undefined } }))
              }
            />
          </Field>
        ) : null}
        {rule.trigger.type === "manual" ? <p className="muted">手动规则只能通过「立即运行」或 API `POST /v1/rules/:name/run` 触发。</p> : null}
      </div>

      <div className="editor-section">
        <div className="section-title">执行器</div>
        <div className="form-grid">
          <Field label="adapter">
            <select
              value={rule.agent.adapter}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  agent: { ...current.agent, adapter: event.target.value as Rule["agent"]["adapter"] },
                }))
              }
            >
              {AGENT_ADAPTERS.map((adapter) => (
                <option key={adapter} value={adapter}>
                  {adapterLabel(adapter)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="access">
            <select
              value={rule.agent.access}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  agent: { ...current.agent, access: event.target.value as Rule["agent"]["access"] },
                }))
              }
            >
              {AGENT_ACCESS.map((access) => (
                <option key={access} value={access}>
                  {access}
                </option>
              ))}
            </select>
          </Field>
          <Field label="cwd">
            <input
              value={rule.agent.cwd}
              onChange={(event) => onChange((current) => ({ ...current, agent: { ...current.agent, cwd: event.target.value } }))}
            />
          </Field>
          <Field label="timeoutMinutes" hint="默认 180">
            <input
              type="number"
              min={1}
              value={rule.agent.timeoutMinutes ?? ""}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  agent: {
                    ...current.agent,
                    timeoutMinutes: event.target.value === "" ? undefined : Number(event.target.value),
                  },
                }))
              }
            />
          </Field>
          <Field label="model（可选）" hint="Cursor 会作为 --model 传递">
            <input
              value={rule.agent.model ?? ""}
              placeholder="留空则使用 CLI 默认模型"
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  agent: { ...current.agent, model: event.target.value || undefined },
                }))
              }
            />
          </Field>
          <Field label="prompt（受信任的任务指令）" className="span-2">
            <textarea
              className="prompt-editor mono"
              value={rule.agent.prompt}
              onChange={(event) => onChange((current) => ({ ...current, agent: { ...current.agent, prompt: event.target.value } }))}
            />
          </Field>
        </div>

        {rule.agent.adapter === "command" ? (
          <CommandEditor
            command={rule.agent.command ?? []}
            onChange={(command) => onChange((current) => ({ ...current, agent: { ...current.agent, command } }))}
          />
        ) : null}
      </div>

      <div className="editor-section">
        <div className="section-title">通知通道</div>
        <div className="check-row">
          {CHANNEL_PRESETS.map((name) => (
            <Toggle
              key={name}
              checked={rule.channels.includes(name)}
              onChange={(checked) => toggleChannel(name, checked)}
              label={name}
            />
          ))}
          {rule.channels
            .filter((name) => !(CHANNEL_PRESETS as readonly string[]).includes(name))
            .map((name) => (
              <Toggle key={name} checked onChange={() => toggleChannel(name, false)} label={name} />
            ))}
        </div>
        <div className="cmd-row">
          <input
            value={customChannel}
            placeholder="自定义通道标签"
            onChange={(event) => setCustomChannel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const name = customChannel.trim();
                if (name) {
                  toggleChannel(name, true);
                  setCustomChannel("");
                }
              }
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => {
              const name = customChannel.trim();
              if (name) {
                toggleChannel(name, true);
                setCustomChannel("");
              }
            }}
          >
            添加
          </button>
        </div>
      </div>
    </>
  );
}

function CommandEditor({ command, onChange }: { command: string[]; onChange: (command: string[]) => void }) {
  const list = command.length === 0 ? [""] : command;
  return (
    <>
      <div className="section-title">command 参数列表</div>
      <p className="hint muted">适配器为 command 时使用。可在参数中加入 {"{prompt}"} 占位符，运行时会被替换为规则 prompt。</p>
      {list.map((item, index) => (
        <div className="cmd-row" key={index}>
          <input
            className="mono"
            value={item}
            placeholder={index === 0 ? "可执行文件，例如 bash" : "参数，可含 {prompt}"}
            onChange={(event) => {
              const next = [...list];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <button
            className="btn icon"
            type="button"
            onClick={() => onChange(list.filter((_, current) => current !== index))}
            disabled={list.length <= 1}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button className="btn sm" type="button" onClick={() => onChange([...list, ""]) }>
        <Plus size={14} strokeWidth={1.75} />
        添加参数
      </button>
    </>
  );
}
