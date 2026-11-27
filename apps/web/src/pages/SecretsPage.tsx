import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../api";
import { useHub } from "../context";
import { COMMON_SECRET_KEYS, type SecretKey } from "../types";
import { Empty, Field } from "../components/ui";

export function SecretsPage() {
  const { toast } = useHub();
  const [keys, setKeys] = useState<SecretKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await api.getSecrets());
    } catch (error) {
      toast({ kind: "error", title: "无法读取密钥列表", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    const key = name.trim();
    if (!key || !value) {
      toast({ kind: "error", title: "请填写密钥名和值" });
      return;
    }
    setBusy(true);
    try {
      const result = await api.putSecrets({ set: { [key]: value } });
      setKeys(result.keys.length > 0 ? result.keys : await api.getSecrets());
      setValue("");
      toast({ kind: "ok", title: "密钥已保存", detail: key });
    } catch (error) {
      toast({ kind: "error", title: "保存失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setBusy(false);
    }
  };

  const unset = async (key: string) => {
    if (!window.confirm(`确定移除密钥 ${key} 吗？控制台不会展示原始值，此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const result = await api.putSecrets({ unset: [key] });
      setKeys(result.keys.length > 0 ? result.keys : await api.getSecrets());
      toast({ kind: "ok", title: "已移除密钥", detail: key });
    } catch (error) {
      toast({ kind: "error", title: "移除失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>密钥管理</h2>
          <p>只展示密钥名与是否已配置，永不显示原始值。通过 `PUT /v1/secrets` 写入或删除。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={() => void reload()}>
            <RefreshCw size={15} strokeWidth={1.75} />
            刷新列表
          </button>
        </div>
      </div>

      <section className="panel">
        <h3>新增 / 更新密钥</h3>
        <div className="option-row" style={{ marginBottom: 14 }}>
          {COMMON_SECRET_KEYS.map((key) => (
            <button key={key} className={`option-btn${name === key ? " selected" : ""}`} type="button" onClick={() => setName(key)}>
              {key}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <Field label="密钥名">
            <input list="common-secrets" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 WEBHOOK_URL" />
            <datalist id="common-secrets">
              {COMMON_SECRET_KEYS.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </Field>
          <Field label="密钥值（输入时掩码，提交后不再回显）">
            <input type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          <Plus size={15} strokeWidth={1.75} />
          保存密钥
        </button>
      </section>

      <section className="panel">
        <h3>已配置密钥</h3>
        {loading ? (
          <Empty>加载中…</Empty>
        ) : keys.length === 0 ? (
          <Empty>还没有密钥。Hub 不会返回原始值，只会告诉你哪些 key 已经配置。</Empty>
        ) : (
          <div className="stack">
            {keys.map((item) => (
              <div className="secret-row" key={item.name}>
                <div>
                  <strong className="mono">{item.name}</strong>
                  <div style={{ marginTop: 6 }}>
                    <span className={`badge ${item.configured ? "ok" : ""}`}>{item.configured ? "已配置" : "未配置"}</span>
                  </div>
                </div>
                <button className="btn sm danger" disabled={busy} onClick={() => void unset(item.name)}>
                  <Trash2 size={14} strokeWidth={1.75} />
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
