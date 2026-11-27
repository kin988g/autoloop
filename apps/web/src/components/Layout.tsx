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

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: PageId; label: string; icon: typeof Activity }>;
}> = [
  {
    label: "工作台",
    items: [
      { id: "monitor", label: "实时监控", icon: Activity },
      { id: "cards", label: "网页拍板卡片", icon: CreditCard },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "rules", label: "规则编辑", icon: Workflow },
      { id: "agents", label: "Agent 与参数", icon: Bot },
      { id: "channels", label: "通道与来源", icon: Radio },
      { id: "secrets", label: "密钥管理", icon: KeyRound },
    ],
  },
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
    live === "live" ? "实时已连接" : live === "polling" ? "轮询同步" : live === "connecting" ? "连接中" : "离线";

  return (
    <div className="app-shell">
      {sidebarOpen ? <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M5.4 9.2a3.4 3.4 0 1 1 3.15-4.7M12.6 8.8a3.4 3.4 0 1 1-3.15 4.7"
                stroke="white"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <h1>AutoLoop Studio</h1>
            <p>配置与审批控制台</p>
          </div>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
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
                    <Icon size={16} strokeWidth={1.75} />
                    <span className="nav-label">{item.label}</span>
                    {item.id === "cards" && openCards > 0 ? <span className="badge warn">{openCards}</span> : null}
                    {item.id === "monitor" && activeRuns > 0 ? <span className="badge accent">{activeRuns}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="live-pill" title="实时订阅">
            <span className={`dot ${live === "live" ? "live" : live === "polling" ? "warn" : "danger"}`} />
            SSE {liveLabel}
          </div>
          <div className="sidebar-meta">Hub {baseUrl || "同源 / 代理"} · v{health?.version ?? "—"}</div>
        </div>
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
              SSE {live === "live" ? "实时" : live === "polling" ? "轮询" : live === "connecting" ? "连接中" : "离线"}
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
              <Settings size={15} strokeWidth={1.75} />
              连接设置
            </button>
            <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={15} strokeWidth={1.75} className={refreshing ? "spin" : undefined} />
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
