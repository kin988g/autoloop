import { useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { useHub } from "../context";
import { formatDateTime, formatRelative } from "../format";
import type { Card, CardStatus } from "../types";
import { Empty, Field, StatusChip } from "../components/ui";

const TABS: Array<{ id: CardStatus | "all"; label: string }> = [
  { id: "open", label: "待处理" },
  { id: "decided", label: "已决策" },
  { id: "done", label: "已完成" },
  { id: "closed", label: "已关闭" },
  { id: "all", label: "全部" },
];

export function CardsPage() {
  const { state, toast, refresh } = useHub();
  const [tab, setTab] = useState<CardStatus | "all">("open");
  const cards = state?.cards ?? [];
  const filtered = useMemo(
    () => (tab === "all" ? cards : cards.filter((card) => card.status === tab)),
    [cards, tab],
  );
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: cards.length };
    for (const card of cards) result[card.status] = (result[card.status] ?? 0) + 1;
    return result;
  }, [cards]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>网页拍板卡片</h2>
          <p>处理 Agent 发出的 ask 决策，查看 notice，并在完成后 resolve 卡片。</p>
        </div>
      </div>
      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.id} className={`tab${tab === item.id ? " active" : ""}`} onClick={() => setTab(item.id)}>
            {item.label}
            <span className={`badge ${item.id === "open" && (counts.open ?? 0) > 0 ? "warn" : ""}`} style={{ marginLeft: 6 }}>
              {counts[item.id] ?? 0}
            </span>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <Empty>当前筛选下没有卡片。</Empty>
      ) : (
        <div className="card-grid">
          {filtered.map((card) => (
            <CardPanel key={card.id} card={card} onChanged={refresh} onToast={toast} />
          ))}
        </div>
      )}
    </div>
  );
}

function CardPanel({
  card,
  onChanged,
  onToast,
}: {
  card: Card;
  onChanged: () => Promise<void>;
  onToast: (item: { kind: "ok" | "error" | "info"; title: string; detail?: string }) => void;
}) {
  const [choice, setChoice] = useState(card.answer?.choice ?? "");
  const [text, setText] = useState(card.answer?.text ?? "");
  const [responder, setResponder] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const canAnswer = card.kind === "ask" && card.status === "open";
  const canResolve = card.status === "open" || card.status === "decided";

  const submitAnswer = async () => {
    if (!choice && !text.trim()) {
      onToast({ kind: "error", title: "请选择一个选项或填写回复" });
      return;
    }
    setBusy(true);
    try {
      const result = await api.answerCard(card.id, {
        choice: choice || undefined,
        text: text.trim() || undefined,
        responder: responder.trim() || undefined,
      });
      onToast({
        kind: "ok",
        title: "已提交答复",
        detail: result.resumedRunId ? `已恢复运行 resumedRunId=${result.resumedRunId}` : "等待 Hub 调度后续 Run",
      });
      await onChanged();
    } catch (error) {
      onToast({ kind: "error", title: "答复失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setBusy(false);
    }
  };

  const submitResolve = async () => {
    setBusy(true);
    try {
      await api.resolveCard(card.id, summary.trim() || undefined);
      onToast({ kind: "ok", title: "卡片已 resolve", detail: card.id });
      await onChanged();
    } catch (error) {
      onToast({ kind: "error", title: "Resolve 失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`card approval-card ${card.kind}`}>
      <header>
        <div>
          <h4>{card.title}</h4>
          <div className="dim" style={{ marginTop: 4 }}>
            {card.ruleName || "未命名规则"} · {card.lane || "default"} · {formatRelative(card.createdAt)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <StatusChip status={card.kind} />
          <StatusChip status={card.status} />
        </div>
      </header>
      {card.body ? <div className="body">{card.body}</div> : null}
      <div className="mono dim">
        card {card.id}
        {card.runId ? ` · run ${card.runId}` : ""}
      </div>

      {canAnswer ? (
        <>
          {card.options && card.options.length > 0 ? (
            <div className="option-row">
              {card.options.map((option) => (
                <button
                  key={option}
                  className={`option-btn${choice === option ? " selected" : ""}`}
                  onClick={() => setChoice(option)}
                  type="button"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <Field label="自由回复（text）">
            <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="可选补充说明" />
          </Field>
          <Field label="答复人（responder，可选）">
            <input value={responder} onChange={(event) => setResponder(event.target.value)} placeholder="你的名字" />
          </Field>
          <button className="btn primary" disabled={busy} onClick={() => void submitAnswer()}>
            提交答复
          </button>
        </>
      ) : null}

      {card.answer && (card.status === "decided" || card.status === "done" || card.status === "closed") ? (
        <div className="worker-item" style={{ display: "block" }}>
          <strong>已记录的答复</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {card.answer.choice ? <div>选项：{card.answer.choice}</div> : null}
            {card.answer.text ? <div>回复：{card.answer.text}</div> : null}
            <div>
              {card.answer.responder ? `${card.answer.responder} · ` : ""}
              {formatDateTime(card.answer.answeredAt)}
            </div>
          </div>
        </div>
      ) : null}

      {canResolve ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Resolve 摘要（可选）" className="span-2" >
            <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="summary" />
          </Field>
          <button className="btn" disabled={busy} onClick={() => void submitResolve()} style={{ marginBottom: 12 }}>
            Resolve
          </button>
        </div>
      ) : null}
    </article>
  );
}
