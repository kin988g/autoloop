import { useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  CreditCard,
  KeyRound,
  Menu,
  Radio,
  RefreshCw,
  Settings,
  Workflow,
} from "lucide-react";
import { useHub, type PageId } from "../context";
import { formatRelative, formatUptime } from "../format";
import { HubSettings } from "./HubSettings";
import { Toasts } from "./ui";

const NAV: Array<{ id: PageId; label: string; icon: typeof Activity }> = [
  { id: "monitor", label: "实时监控", icon: Activity },
  { id: "cards", label: "网页拍板卡片", icon: CreditCard },
  { id: "rules", label: "规则编辑", icon: Workflow },
  { id: "agents", label: "Agent 与参数", icon: Bot },
  { id: "channels", label: "通道与来源", icon: Radio },
  { id: "secrets", label: "密钥管理", icon: KeyRound },
];

export function Layout({ children }: { children: ReactNode }) {
  const {
    page,
    setPage,
    health,
    state,
    online,
    live,
    lastError,
    lastUpdatedAt,
    refreshing,
    refresh,
    setSettingsOpen,
    baseUrl,
  } = useHub();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openCards = state?.stats.openCards ?? state?.cards.filter((card) => card.status === "open").length ?? 0;
  const activeRuns = state?.stats.activeRuns ?? 0;
  const liveLabel =
    live === "live" ? "实时" : live === "polling" ? "轮询" : live === "connecting" ? "连接中" : "离线";

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <h1>AutoLoop Studio</h1>
            <p>配置与审批控制台</p>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-btn${page === item.id ? " active" : ""}`}
                onClick={() => {
                  setPage(item.id);
                  setSidebarOpen(false);
                }}
              >
                <Icon size={16} />
                <span className="nav-label">{item.label}</span>
                {item.id === "cards" && openCards > 0 ? <span className="badge warn">{openCards}</span> : null}
                {item.id === "monitor" && activeRuns > 0 ? <span className="badge accent">{activeRuns}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">Hub {baseUrl || "同源 / 代理"} · v{health?.version ?? "—"}</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn icon menu-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="菜单">
            <Menu size={16} />
          </button>
          <div className="status-cluster">
            <span className="pill" title="Hub 健康状态">
              <span className={`dot ${online && health?.ok ? "ok" : "danger"}`} />
              <strong>{online && health?.ok ? "ok" : "离线"}</strong>
              <span>{health?.version ?? "—"}</span>
              <span>{health ? formatUptime(health.uptimeMs) : "—"}</span>
            </span>
            <span className="pill" title="实时订阅">
              <span className={`dot ${live === "live" ? "live" : live === "polling" ? "warn" : "danger"}`} />
              SSE {liveLabel}
            </span>
            <span className="pill">
              待审批 <strong>{openCards}</strong>
            </span>
            <span className="pill">
              进行中 Runs <strong>{activeRuns}</strong>
            </span>
            <span className="pill dim">更新 {formatRelative(lastUpdatedAt)}</span>
          </div>
          <div className="topbar-actions">
            <button className="btn" onClick={() => setSettingsOpen(true)}>
              <Settings size={15} />
              连接设置
            </button>
            <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
              刷新
            </button>
          </div>
        </header>
        {!online ? (
          <div className="page" style={{ paddingBottom: 0 }}>
            <div className="banner">
              无法连接 Hub（默认 127.0.0.1:3350）。请确认服务已启动，或在右上角调整连接设置。
              {lastError ? <span className="dim">（{lastError}）</span> : null}
            </div>
          </div>
        ) : null}
        {children}
      </div>
      <HubSettings />
      <Toasts />
    </div>
  );
}
