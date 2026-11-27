import { useEffect, useState, type ReactNode } from "react";
import { Cloud, Github, Globe, Monitor, Radio, Save } from "lucide-react";
import { api } from "../api";
import { useConfigDraft } from "../hooks/useConfigDraft";
import { presetLabel } from "../format";
import { WEBHOOK_PRESETS, type SecretKey } from "../types";
import { Field, SaveBar, Toggle } from "../components/ui";

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
        <div className="page-header-actions">
          {dirty ? (
            <span className="pill">
              <span className="dirty-dot" /> 有未保存更改
            </span>
          ) : null}
          <button className="btn" disabled={!dirty} onClick={reset}>
            重置
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Save size={15} strokeWidth={1.75} />
            保存配置
          </button>
        </div>
      </div>

      <section className="panel">
        <h3>通道 channels</h3>
        <div className="channel-list">
          <div className="channel-row-head">
            <div className="agent-card-title">
              <span className="agent-icon web">
                <Globe size={16} strokeWidth={1.75} />
              </span>
              <div>
                <h3>Web 控制台通道</h3>
                <p>在控制台展示审批卡片与通知</p>
              </div>
            </div>
            <Toggle
              checked={draft.channels.web.enabled}
              onChange={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, web: { enabled } },
                }))
              }
              ariaLabel="启用 web"
              label="启用 web"
            />
          </div>

          <div className="channel-row-head">
            <div className="agent-card-title">
              <span className="agent-icon desktop">
                <Monitor size={16} strokeWidth={1.75} />
              </span>
              <div>
                <h3>Desktop 通道</h3>
                <p>向本机桌面发送通知</p>
              </div>
            </div>
            <Toggle
              checked={draft.channels.desktop.enabled}
              onChange={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, desktop: { enabled } },
                }))
              }
              ariaLabel="启用 desktop"
              label="启用 desktop"
            />
          </div>
        </div>
      </section>

      <section className="panel">
        <ChannelHead
          tone="feishu"
          title="飞书 feishu"
          subtitle="通过飞书机器人 Webhook 或应用凭证推送卡片"
          icon={<Cloud size={16} strokeWidth={1.75} />}
          enabled={feishu.enabled}
          onToggle={(enabled) =>
            setDraft((current) => ({
              ...current,
              channels: { ...current.channels, feishu: { ...feishu, enabled } },
            }))
          }
          label="启用飞书通道"
        />
        <div className="form-grid">
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
      </section>

      <section className="panel">
        <ChannelHead
          tone="webhook"
          title="Webhook 通道"
          subtitle="推送到钉钉、企业微信、Slack、Discord 或自定义地址"
          icon={<Radio size={16} strokeWidth={1.75} />}
          enabled={webhook.enabled}
          onToggle={(enabled) =>
            setDraft((current) => ({
              ...current,
              channels: { ...current.channels, webhook: { ...webhook, enabled } },
            }))
          }
          label="启用 webhook"
        />
        <div className="form-grid">
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
          <Field label="urlSecret（密钥名）">
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
        <div className="channel-list">
          <div>
            <ChannelHead
              tone="github"
              title="GitHub"
              subtitle="接收 GitHub webhook 事件"
              icon={<Github size={16} strokeWidth={1.75} />}
              enabled={github.enabled}
              onToggle={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  sources: { ...current.sources, github: { ...github, enabled } },
                }))
              }
              label="启用 GitHub"
            />
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
          </div>
          <div>
            <ChannelHead
              tone="gitlab"
              title="GitLab"
              subtitle="接收 GitLab webhook 事件"
              icon={<GitlabMark />}
              enabled={gitlab.enabled}
              onToggle={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  sources: { ...current.sources, gitlab: { ...gitlab, enabled } },
                }))
              }
              label="启用 GitLab"
            />
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
        </div>
      </section>

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void save()} saveLabel="保存配置" />
    </div>
  );
}

function ChannelHead({
  tone,
  title,
  subtitle,
  icon,
  enabled,
  onToggle,
  label,
}: {
  tone: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  label: string;
}) {
  return (
    <div className="channel-row-head">
      <div className="agent-card-title">
        <span className={`agent-icon ${tone}`}>{icon}</span>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      <Toggle checked={enabled} onChange={onToggle} label={label} />
    </div>
  );
}

function GitlabMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21.2l3.3-10.15H8.7L12 21.2zM8.7 11.05L6.55 4.4a.4.4 0 0 0-.76.05L3 11.05h5.7zm11.3 0h-5.7l2.15-6.65a.4.4 0 0 1 .76.05L20 11.05zM3 11.05l8.2 10.15L1.7 14.3a.8.8 0 0 1 .3-1.15L3 11.05zm18 0l1 2.1a.8.8 0 0 1-.3 1.15L12.8 21.2 21 11.05z"
        fill="currentColor"
      />
    </svg>
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
