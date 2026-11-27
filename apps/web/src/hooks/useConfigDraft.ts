import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useHub } from "../context";
import { cloneConfig, type AppConfig } from "../types";

let sharedDraft: AppConfig | null = null;
let sharedBaseline = "";
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function useConfigDraft() {
  const { config, applyStateConfig, toast, refresh } = useHub();
  const [, bump] = useState(0);

  useEffect(() => {
    const listener = () => bump((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const next = JSON.stringify(config);
    if (!sharedDraft || sharedBaseline === JSON.stringify(sharedDraft)) {
      sharedDraft = cloneConfig(config);
      sharedBaseline = next;
      emit();
    }
  }, [config]);

  const draft = sharedDraft ? cloneConfig(sharedDraft) : cloneConfig(config);
  const dirty = JSON.stringify(draft) !== sharedBaseline;

  const setDraft = useCallback((updater: AppConfig | ((current: AppConfig) => AppConfig)) => {
    const current = sharedDraft ? cloneConfig(sharedDraft) : cloneConfig(config);
    sharedDraft = typeof updater === "function" ? updater(current) : updater;
    emit();
  }, [config]);

  const reset = useCallback(() => {
    const parsed = JSON.parse(sharedBaseline || JSON.stringify(config)) as AppConfig;
    sharedDraft = cloneConfig(parsed);
    emit();
  }, [config]);

  const save = useCallback(async () => {
    if (!sharedDraft) return;
    try {
      const result = await api.putConfig(sharedDraft);
      const saved = result.config;
      sharedDraft = cloneConfig(saved);
      sharedBaseline = JSON.stringify(saved);
      applyStateConfig(saved);
      emit();
      toast({ kind: "ok", title: "配置已保存" });
      await refresh();
    } catch (error) {
      toast({ kind: "error", title: "保存配置失败", detail: error instanceof ApiError ? error.message : "未知错误" });
    }
  }, [applyStateConfig, toast, refresh]);

  return { draft, dirty, setDraft, reset, save };
}
