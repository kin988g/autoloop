import { useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import { api, ApiError } from "../api";
import { useHub } from "../context";
import { formatDateTime, formatRelative, statusLabel } from "../format";
import { isActiveRunStatus, type PostEventBody, type RunRecord } from "../types";
import { Empty, Field, Modal, StatusChip } from "../components/ui";

export function MonitorPage() {
  const { state, toast, refresh } = useHub();
  const stats = state?.stats;
  const runs = state?.runs ?? [];
  const workers = state?.workers ?? [];
  const rules = state?.rules ?? [];
  const [ruleFilter, setRuleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<RunRecord | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const statuses = useMemo(() => Array.from(new Set(runs.map((run) => run.status))).sort(), [runs]);
  const ruleNames = useMemo(() => Array.from(new Set(runs.map((run) => run.ruleName).filter(Boolean))).sort(), [runs]);
  const filtered = runs.filter((run) => {
    if (ruleFilter && run.ruleName !== ruleFilter) return false;
    if (statusFilter && run.status !== statusFilter) return false;
    return true;
  });

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await api.cancelRun(id);
      toast({ kind: "ok", title: "已发送取消请求", detail: id });
      await refresh();
    } catch (error) {
      toast({ kind: "error", title: "取消失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>实时监控</h2>
          <p>查看 Hub 运行指标、已连接 Worker 与 Live Runs。</p>
        </div>
        <button className="btn primary" onClick={() => setEventOpen(true)}>
          <Send size={15} />
          发送测试事件
        </button>
      </div>

      <div className="kpi-grid">
        <Kpi label="总 Runs" value={stats?.totalRuns ?? 0} hint="totalRuns" />
        <Kpi label="进行中" value={stats?.activeRuns ?? 0} hint="activeRuns" />
        <Kpi label="待审批卡片" value={stats?.openCards ?? 0} hint="openCards" />
        <Kpi label="事件总数" value={stats?.totalEvents ?? 0} hint="totalEvents" />
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="toolbar">
            <h3 style={{ margin: 0, flex: 1 }}>Live Runs</h3>
            <select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}>
              <option value="">全部规则</option>
              {ruleNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">全部状态</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </div>
          {filtered.length === 0 ? (
            <Empty>暂无运行记录。可以用「发送测试事件」或在规则页点击「立即运行」。</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>规则</th>
                    <th>状态</th>
                    <th>Lane</th>
                    <th>时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((run) => (
                    <tr key={run.id} className="clickable" onClick={() => setSelected(run)}>
                      <td className="mono truncate" title={run.id}>
                        {run.id}
                      </td>
                      <td>{run.ruleName || "—"}</td>
                      <td>
                        <StatusChip status={run.status} />
                      </td>
                      <td className="muted">{run.lane || "—"}</td>
                      <td className="muted">{formatRelative(run.updatedAt ?? run.startedAt ?? run.createdAt)}</td>
                      <td>
                        {isActiveRunStatus(run.status) ? (
                          <button
                            className="btn sm danger"
                            disabled={cancelling === run.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void cancel(run.id);
                            }}
                          >
                            {cancelling === run.id ? "取消中…" : "取消"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h3>已连接 Workers</h3>
          {workers.length === 0 ? (
            <Empty>暂无 Worker 心跳。确认 worker.enabled 并且 Worker 进程已启动。</Empty>
          ) : (
            <div className="worker-list">
              {workers.map((worker) => {
                const online = worker.connected !== false && worker.online !== false;
                return (
                  <div className="worker-item" key={worker.name}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span className={`dot ${online ? "ok" : "danger"}`} />
                        <strong>{worker.name}</strong>
                      </div>
                      <div className="dim" style={{ marginTop: 4 }}>
                        {typeof worker.capacity === "number" ? `容量 ${worker.capacity}` : "容量 —"}
                        {` · 占用 ${worker.running.length}`}
                        {worker.lastSeenAt ? ` · ${formatRelative(worker.lastSeenAt)}` : ""}
                      </div>
                      {worker.running.length > 0 ? (
                        <div className="mono dim" style={{ marginTop: 4 }}>
                          {worker.running.join(", ")}
                        </div>
                      ) : null}
                    </div>
                    <StatusChip status={online ? "running" : "closed"} />
                  </div>
                );
              })}
            </div>
          )}
          {rules.length > 0 ? (
            <p className="dim" style={{ marginTop: 14, marginBottom: 0 }}>
              已加载 {rules.length} 条规则，{rules.filter((rule) => rule.enabled && !rule.paused).length} 条处于可调度状态。
            </p>
          ) : null}
        </section>
      </div>

      {selected ? (
        <Modal title={`Run ${selected.id}`} onClose={() => setSelected(null)} drawer>
          <dl className="kv">
            <dt>规则</dt>
            <dd>{selected.ruleName || "—"}</dd>
            <dt>状态</dt>
            <dd>
              <StatusChip status={selected.status} />
              {selected.outcome ? ` · 结果 ${statusLabel(selected.outcome)}` : ""}
            </dd>
            <dt>Lane</dt>
            <dd>{selected.lane || "—"}</dd>
            <dt>Session</dt>
            <dd className="mono">{selected.sessionId || "—"}</dd>
            <dt>Worker</dt>
            <dd>{selected.worker || "—"}</dd>
            <dt>Attempt / Hops</dt>
            <dd>
              {selected.attempt ?? "—"} / {selected.hops ?? "—"}
            </dd>
            <dt>事件</dt>
            <dd className="mono">{selected.eventIds && selected.eventIds.length > 0 ? selected.eventIds.join(", ") : "—"}</dd>
            <dt>创建</dt>
            <dd>{formatDateTime(selected.createdAt)}</dd>
            <dt>领取</dt>
            <dd>{formatDateTime(selected.claimedAt)}</dd>
            <dt>开始</dt>
            <dd>{formatDateTime(selected.startedAt)}</dd>
            <dt>更新</dt>
            <dd>{formatDateTime(selected.updatedAt)}</dd>
            <dt>结束</dt>
            <dd>{formatDateTime(selected.finishedAt)}</dd>
            <dt>错误</dt>
            <dd>{selected.error || "—"}</dd>
            <dt>Usage</dt>
            <dd className="mono">
              {selected.usage && Object.keys(selected.usage).length > 0
                ? Object.entries(selected.usage)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")
                : "—"}
            </dd>
          </dl>
          {isActiveRunStatus(selected.status) ? (
            <div className="toolbar" style={{ marginTop: 16, marginBottom: 0 }}>
              <button
                className="btn danger"
                disabled={cancelling === selected.id}
                onClick={() => void cancel(selected.id)}
              >
                取消该 Run
              </button>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {eventOpen ? <EventModal onClose={() => setEventOpen(false)} /> : null}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

function EventModal({ onClose }: { onClose: () => void }) {
  const { toast, refresh } = useHub();
  const [type, setType] = useState("test.ping");
  const [source, setSource] = useState("web");
  const [lane, setLane] = useState("");
  const [dedupeKey, setDedupeKey] = useState("");
  const [hops, setHops] = useState("");
  const [payloadText, setPayloadText] = useState("{\n  \"message\": \"hello from AutoLoop Studio\"\n}");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    let payload: unknown = undefined;
    if (payloadText.trim()) {
      try {
        payload = JSON.parse(payloadText) as unknown;
      } catch {
        toast({ kind: "error", title: "payload 不是合法 JSON" });
        return;
      }
    }
    const hopsNum = hops.trim() ? Number(hops) : undefined;
    if (hops.trim() && (!Number.isFinite(hopsNum) || (hopsNum ?? 0) < 0)) {
      toast({ kind: "error", title: "hops 必须是非负数字" });
      return;
    }
    const body: PostEventBody = {
      type: type.trim(),
      source: source.trim(),
    };
    if (lane.trim()) body.lane = lane.trim();
    if (payload !== undefined) body.payload = payload;
    if (dedupeKey.trim()) body.dedupeKey = dedupeKey.trim();
    if (typeof hopsNum === "number") body.hops = hopsNum;
    if (!body.type || !body.source) {
      toast({ kind: "error", title: "type 与 source 为必填" });
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.postEvent(body);
      const bits = [
        result.eventId ? `eventId=${result.eventId}` : null,
        result.runId ? `runId=${result.runId}` : null,
        `queued=${result.queued ? "是" : "否"}`,
        result.circuitBroken ? "circuitBroken=true" : null,
      ].filter(Boolean);
      toast({ kind: "ok", title: "测试事件已发送", detail: bits.join(" · ") });
      await refresh();
      onClose();
    } catch (error) {
      toast({ kind: "error", title: "发送失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="发送测试事件" onClose={onClose}>
      <div className="form-grid">
        <Field label="type">
          <input value={type} onChange={(event) => setType(event.target.value)} />
        </Field>
        <Field label="source">
          <input value={source} onChange={(event) => setSource(event.target.value)} />
        </Field>
        <Field label="lane（可选）">
          <input value={lane} onChange={(event) => setLane(event.target.value)} />
        </Field>
        <Field label="dedupeKey（可选）">
          <input value={dedupeKey} onChange={(event) => setDedupeKey(event.target.value)} />
        </Field>
        <Field label="hops（可选）">
          <input type="number" min={0} value={hops} onChange={(event) => setHops(event.target.value)} />
        </Field>
        <Field label="payload JSON（可选）" className="span-2">
          <textarea className="json-view" style={{ minHeight: 160 }} value={payloadText} onChange={(event) => setPayloadText(event.target.value)} />
        </Field>
      </div>
      <div className="toolbar" style={{ justifyContent: "flex-end", marginBottom: 0 }}>
        <button className="btn ghost" onClick={onClose}>
          <X size={14} />
          取消
        </button>
        <button className="btn primary" disabled={submitting} onClick={() => void submit()}>
          发送
        </button>
      </div>
    </Modal>
  );
}
