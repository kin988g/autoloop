import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "../api";
import { useConfigDraft } from "../hooks/useConfigDraft";
import { presetLabel } from "../format";
import { WEBHOOK_PRESETS, type SecretKey } from "../types";
import { Field } from "../components/ui";

export function ChannelsPage() {
  const { draft, dirty, setDraft, reset, save } = useConfigDraft();
  const [secrets, setSecrets] = useState<SecretKey[]>([]);

  useEffect(() => {
    void api
      .getSecrets()
      .then(setSecrets)
      .catch(() => setSecrets([]));
  }, []);

  const secretNames = secrets.filter((item) => item.configured).map((item) => item.name);
  const feishu = draft.channels.feishu ?? { enabled: false };
  const webhook = draft.channels.webhook ?? { enabled: false };
  const github = draft.sources.github ?? { enabled: false };
  const gitlab = draft.sources.gitlab ?? { enabled: false };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>通道与来源</h2>
          <p>管理通知通道（web / desktop / 飞书 / webhook）以及 GitHub / GitLab 来源。密钥字段可从已配置 secrets 中选择。</p>
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
        <h3>通道 channels</h3>
        <div className="form-grid">
          <Field label="Web 控制台通道">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.channels.web.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channels: { ...current.channels, web: { enabled: event.target.checked } },
                  }))
                }
              />
              启用 web
            </label>
          </Field>
          <Field label="Desktop 通道">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.channels.desktop.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channels: { ...current.channels, desktop: { enabled: event.target.checked } },
                  }))
                }
              />
              启用 desktop
            </label>
          </Field>
        </div>

        <div className="section-title">飞书 feishu</div>
        <div className="form-grid">
          <Field label="启用" className="span-2">
            <label className="check">
              <input
                type="checkbox"
                checked={feishu.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channels: { ...current.channels, feishu: { ...feishu, enabled: event.target.checked } },
                  }))
                }
              />
              启用飞书通道
            </label>
          </Field>
          <Field label="webhookUrlSecret（密钥名）">
            <SecretNameInput
              value={feishu.webhookUrlSecret ?? ""}
              secrets={secretNames}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, feishu: { ...feishu, webhookUrlSecret: value || undefined } },
                }))
              }
            />
          </Field>
          <Field label="appId（可选）">
            <input
              value={feishu.appId ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, feishu: { ...feishu, appId: event.target.value || undefined } },
                }))
              }
            />
          </Field>
          <Field label="appSecretKey（密钥名）" className="span-2">
            <SecretNameInput
              value={feishu.appSecretKey ?? ""}
              secrets={secretNames}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, feishu: { ...feishu, appSecretKey: value || undefined } },
                }))
              }
            />
          </Field>
        </div>

        <div className="section-title">Webhook 通道</div>
        <div className="form-grid">
          <Field label="启用">
            <label className="check">
              <input
                type="checkbox"
                checked={webhook.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channels: { ...current.channels, webhook: { ...webhook, enabled: event.target.checked } },
                  }))
                }
              />
              启用 webhook
            </label>
          </Field>
          <Field label="preset">
            <select
              value={webhook.preset ?? "custom"}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  channels: {
                    ...current.channels,
                    webhook: { ...webhook, preset: event.target.value as NonNullable<typeof webhook.preset> },
                  },
                }))
              }
            >
              {WEBHOOK_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {presetLabel(preset)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="urlSecret（密钥名）" className="span-2">
            <SecretNameInput
              value={webhook.urlSecret ?? ""}
              secrets={secretNames}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, webhook: { ...webhook, urlSecret: value || undefined } },
                }))
              }
            />
          </Field>
        </div>
      </section>

      <section className="panel">
        <h3>来源 sources</h3>
        <div className="form-grid">
          <Field label="GitHub">
            <label className="check">
              <input
                type="checkbox"
                checked={github.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sources: { ...current.sources, github: { ...github, enabled: event.target.checked } },
                  }))
                }
              />
              启用 GitHub
            </label>
          </Field>
          <Field label="webhookSecretKey（密钥名）">
            <SecretNameInput
              value={github.webhookSecretKey ?? ""}
              secrets={secretNames}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  sources: { ...current.sources, github: { ...github, webhookSecretKey: value || undefined } },
                }))
              }
            />
          </Field>
          <Field label="GitLab">
            <label className="check">
              <input
                type="checkbox"
                checked={gitlab.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sources: { ...current.sources, gitlab: { ...gitlab, enabled: event.target.checked } },
                  }))
                }
              />
              启用 GitLab
            </label>
          </Field>
          <Field label="webhookSecretKey（密钥名）">
            <SecretNameInput
              value={gitlab.webhookSecretKey ?? ""}
              secrets={secretNames}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  sources: { ...current.sources, gitlab: { ...gitlab, webhookSecretKey: value || undefined } },
                }))
              }
            />
          </Field>
        </div>
      </section>
    </div>
  );
}

function SecretNameInput({
  value,
  secrets,
  onChange,
}: {
  value: string;
  secrets: string[];
  onChange: (value: string) => void;
}) {
  const listId = `secrets-${value.length}-${secrets.join("-").slice(0, 24)}`;
  return (
    <>
      <input list={listId} value={value} placeholder="选择或输入密钥名" onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {secrets.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}
