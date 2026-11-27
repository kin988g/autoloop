import { useState } from "react";
import { api, ApiError, DEFAULT_BASE_URL } from "../api";
import { useHub } from "../context";
import { formatUptime } from "../format";
import { Modal, Field } from "./ui";

export function HubSettings() {
  const { settingsOpen, setSettingsOpen, baseUrl, token, setConnection, health, toast } = useHub();
  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [draftToken, setDraftToken] = useState(token);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (!settingsOpen) return null;

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.healthz({ baseUrl: draftUrl.trim(), token: draftToken.trim() });
      setTestResult(
        result.ok
          ? `连接成功 · 版本 ${result.version} · 已运行 ${formatUptime(result.uptimeMs)}`
          : "已连通，但健康检查未返回 ok",
      );
    } catch (error) {
      setTestResult(error instanceof ApiError ? error.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal title="Hub 连接设置" onClose={() => setSettingsOpen(false)}>
      <Field
        label="Hub Base URL"
        hint="留空表示同源请求。开发环境下将通过 Vite 代理转发到 http://127.0.0.1:3350；也可以填写完整地址，例如 http://127.0.0.1:3350。"
      >
        <input
          type="text"
          value={draftUrl}
          placeholder="（留空 = 同源 / Vite 代理）"
          onChange={(event) => setDraftUrl(event.target.value)}
        />
      </Field>
      <Field label="Bearer Token（可选）" hint="填写后，实时订阅将改用带 Authorization 头的 fetch 流，而不使用 EventSource。">
        <input
          type="password"
          autoComplete="off"
          value={draftToken}
          placeholder="可选"
          onChange={(event) => setDraftToken(event.target.value)}
        />
      </Field>
      {health ? (
        <p className="muted">
          当前已连接版本 <strong>{health.version}</strong>，运行时长 {formatUptime(health.uptimeMs)}。
        </p>
      ) : null}
      {testResult ? <div className="banner info">{testResult}</div> : null}
      <div className="toolbar" style={{ marginTop: 16, marginBottom: 0, justifyContent: "space-between" }}>
        <button
          className="btn ghost sm"
          onClick={() => {
            setDraftUrl(DEFAULT_BASE_URL);
            setDraftToken("");
          }}
        >
          恢复同源默认
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => void test()} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setConnection(draftUrl, draftToken);
              setSettingsOpen(false);
              toast({ kind: "ok", title: "已保存连接设置" });
            }}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
