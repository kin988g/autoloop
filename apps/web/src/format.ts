const TZ = "Asia/Shanghai";

export function toMillis(ts?: number | null): number | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

export function formatDateTime(ts?: number | null): string {
  const ms = toMillis(ts);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelative(ts?: number | null, now = Date.now()): string {
  const ms = toMillis(ts);
  if (ms === null) return "—";
  const diff = Math.round((now - ms) / 1000);
  if (Math.abs(diff) < 5) return "刚刚";
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60) return `${ahead} 秒后`;
    if (ahead < 3600) return `${Math.floor(ahead / 60)} 分钟后`;
    return formatDateTime(ts);
  }
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return formatDateTime(ts);
}

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function statusLabel(status: string): string {
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
    done_ok: "完成",
    nothing: "无操作",
    failed: "失败",
    cancelled: "已取消",
    canceled: "已取消",
    unknown: "未知",
    ask: "征求决策",
    notice: "通知",
  };
  return map[status] ?? status;
}

export function triggerLabel(type: string): string {
  const map: Record<string, string> = {
    cron: "定时",
    webhook: "Webhook",
    manual: "手动",
    event: "事件",
  };
  return map[type] ?? type;
}

export function adapterLabel(adapter: string): string {
  const map: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    command: "Command",
    doubao: "豆包 / Doubao",
  };
  return map[adapter] ?? adapter;
}

export function accessLabel(access: string): string {
  const map: Record<string, string> = {
    plan: "Plan（只读规划）",
    acceptEdits: "Accept Edits（接受编辑）",
    bypassPermissions: "Bypass Permissions",
  };
  return map[access] ?? access;
}

export function presetLabel(preset: string): string {
  const map: Record<string, string> = {
    dingtalk: "钉钉",
    wecom: "企业微信",
    slack: "Slack",
    discord: "Discord",
    custom: "自定义",
  };
  return map[preset] ?? preset;
}
