import { execFile as execFileCallback } from "node:child_process";
import { platform as nodePlatform } from "node:os";
import type { AppConfig, Card, ChannelAdapter, ChannelSendResult } from "./types.ts";

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout?: string; stderr?: string }>;

export interface DesktopChannelOptions {
  platform?: typeof process.platform;
  execFileFn?: ExecFileFn;
}

function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function flattenText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeAppleScript(value: string): string {
  return flattenText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePowerShellSingle(value: string): string {
  return flattenText(value).replace(/'/g, "''");
}

function commandFor(
  platform: typeof process.platform,
  card: Card,
): { file: string; args: string[] } | { error: string } {
  const title = flattenText(card.title) || "AutoLoop Studio";
  const body = flattenText(card.body) || card.kind;
  const subtitle = flattenText([card.ruleName, card.lane].filter(Boolean).join(" · "));

  if (platform === "darwin") {
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}"`;
    return { file: "osascript", args: ["-e", script] };
  }

  if (platform === "linux") {
    return { file: "notify-send", args: [title, body] };
  }

  if (platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$title = '${escapePowerShellSingle(title)}'`,
      `$body = '${escapePowerShellSingle(body)}'`,
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      "$n.Visible = $true",
      "$n.ShowBalloonTip(5000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)",
      "Start-Sleep -Milliseconds 5500",
      "$n.Dispose()",
    ].join("; ");
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }

  return { error: `Unsupported platform: ${platform}` };
}

export function createDesktopChannel(opts: DesktopChannelOptions = {}): ChannelAdapter {
  const exec = opts.execFileFn ?? defaultExecFile;
  const resolvedPlatform = opts.platform ?? nodePlatform();

  return {
    name: "desktop",
    async sendCard(
      card: Card,
      config: AppConfig,
      _secrets: Record<string, string>,
    ): Promise<ChannelSendResult> {
      if (!config.channels.desktop.enabled) {
        return { ok: false, error: "Desktop channel is disabled" };
      }
      const command = commandFor(resolvedPlatform, card);
      if ("error" in command) {
        return { ok: false, error: command.error };
      }
      try {
        await exec(command.file, command.args);
        return { ok: true, externalId: `desktop:${card.id}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  };
}

export const desktopChannel = createDesktopChannel();
