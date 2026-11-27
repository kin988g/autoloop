export type {
  Card,
  AppConfig,
  ChannelSendResult,
  ChannelAdapter,
} from "./types.ts";
export { buildCardUrl } from "./types.ts";

export { desktopChannel, createDesktopChannel } from "./desktop.ts";
export type { DesktopChannelOptions, ExecFileFn } from "./desktop.ts";

export {
  feishuChannel,
  createFeishuChannel,
  buildFeishuCardPayload,
  parseFeishuCallback,
} from "./feishu.ts";
export type { FeishuChannelOptions, FeishuCallbackResult } from "./feishu.ts";

export {
  webhookChannel,
  createWebhookChannel,
  buildWebhookPayload,
  renderWebhookTemplate,
} from "./webhook.ts";
export type { WebhookChannelOptions, WebhookPreset } from "./webhook.ts";

export { ChannelDispatcher } from "./dispatcher.ts";
export type {
  ChannelDispatcherOptions,
  CardDelivery,
  DispatchPollResult,
} from "./dispatcher.ts";

import type { ChannelAdapter } from "./types.ts";
import { desktopChannel } from "./desktop.ts";
import { feishuChannel } from "./feishu.ts";
import { webhookChannel } from "./webhook.ts";

export const channelAdapters: Record<string, ChannelAdapter> = {
  desktop: desktopChannel,
  feishu: feishuChannel,
  webhook: webhookChannel,
};

export function getChannelAdapter(name: string): ChannelAdapter | undefined {
  return channelAdapters[name] ?? channelAdapters[name.toLowerCase()];
}
