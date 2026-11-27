import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useHub, type ToastItem } from "../context";

export function StatusChip({ status }: { status: string }) {
  return <span className={`status-chip ${status.toLowerCase()}`}>{statusLabelSafe(status)}</span>;
}

function statusLabelSafe(status: string): string {
  const map: Record<string, string> = {
    open: "待处理",
    decided: "已决策",
    done: "已完成",
    closed: "已关闭",
    queued: "排队中",
    claimed: "已领取",
    pending: "待执行",
    running: "运行中",
    started: "已启动",
    active: "进行中",
    in_progress: "进行中",
    nothing: "无操作",
    failed: "失败",
    cancelled: "已取消",
    canceled: "已取消",
    unknown: "未知",
    ask: "征求决策",
    notice: "通知",
    ok: "正常",
    enabled: "启用",
    paused: "已暂停",
    disabled: "停用",
  };
  return map[status] ?? status;
}

export function Modal({
  title,
  children,
  onClose,
  wide,
  drawer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
}) {
  return (
    <div className={`overlay${drawer ? " right" : ""}`} onClick={onClose} role="presentation">
      <div
        className={drawer ? "drawer" : "modal"}
        style={wide && !drawer ? { width: "min(720px, 100%)" } : undefined}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h3>{title}</h3>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useHub();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onClose={() => dismissToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  return (
    <div className={`toast ${toast.kind}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="title">{toast.title}</div>
          {toast.detail ? <div className="detail">{toast.detail}</div> : null}
        </div>
        <button className="btn icon sm ghost" onClick={onClose} aria-label="关闭通知">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className ?? ""}`.trim()}>
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
