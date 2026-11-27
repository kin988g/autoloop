import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  connectStream,
  getStoredBaseUrl,
  getStoredToken,
  persistConnection,
  type LiveMode,
} from "./api";
import {
  cloneConfig,
  DEFAULT_CONFIG,
  DEFAULT_STATS,
  parseAppConfig,
  type AppConfig,
  type Healthz,
  type HubState,
  type Rule,
} from "./types";

export type PageId = "monitor" | "cards" | "rules" | "agents" | "channels" | "secrets";

export interface ToastItem {
  id: string;
  kind: "ok" | "error" | "info";
  title: string;
  detail?: string;
}

interface HubContextValue {
  page: PageId;
  setPage: (page: PageId) => void;
  baseUrl: string;
  token: string;
  setConnection: (baseUrl: string, token: string) => void;
  health: Healthz | null;
  state: HubState | null;
  config: AppConfig;
  rules: Rule[];
  online: boolean;
  live: LiveMode;
  lastError: string | null;
  lastUpdatedAt: number | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toasts: ToastItem[];
  toast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
  applyStateRules: (rules: Rule[]) => void;
  applyStateConfig: (config: AppConfig) => void;
}

const HubContext = createContext<HubContextValue | null>(null);

let toastSeq = 0;

export function HubProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>("monitor");
  const [baseUrl, setBaseUrl] = useState(getStoredBaseUrl);
  const [token, setToken] = useState(getStoredToken);
  const [health, setHealth] = useState<Healthz | null>(null);
  const [state, setState] = useState<HubState | null>(null);
  const [online, setOnline] = useState(true);
  const [live, setLive] = useState<LiveMode>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const connRef = useRef({ baseUrl, token });
  connRef.current = { baseUrl, token };

  const toast = useCallback((item: Omit<ToastItem, "id">) => {
    const id = `t-${Date.now()}-${toastSeq++}`;
    setToasts((prev) => [...prev.slice(-4), { ...item, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextHealth, nextState] = await Promise.all([
        api.healthz({ baseUrl: connRef.current.baseUrl, token: connRef.current.token }),
        api.getState(),
      ]);
      setHealth(nextHealth);
      setState(nextState);
      setOnline(true);
      setLastError(null);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "无法连接 Hub";
      setOnline(false);
      setLive("offline");
      setLastError(message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, baseUrl, token]);

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const ensurePoll = (enabled: boolean) => {
      if (enabled && !pollTimer) {
        pollTimer = setInterval(() => {
          void refresh();
        }, 5000);
      }
      if (!enabled && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const stop = connectStream({
      baseUrl,
      token,
      onEvent: () => {
        void refresh();
      },
      onStatus: (mode) => {
        setLive(mode);
        ensurePoll(mode === "polling" || mode === "connecting");
      },
      onError: (message) => {
        setLastError(message);
      },
    });

    return () => {
      stop();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [baseUrl, token, refresh]);

  const setConnection = useCallback((nextBase: string, nextToken: string) => {
    const trimmedBase = nextBase.trim();
    const trimmedToken = nextToken.trim();
    persistConnection(trimmedBase, trimmedToken);
    setBaseUrl(trimmedBase);
    setToken(trimmedToken);
  }, []);

  const applyStateRules = useCallback((rules: Rule[]) => {
    setState((prev) =>
      prev
        ? { ...prev, rules }
        : {
            config: DEFAULT_CONFIG,
            rules,
            runs: [],
            cards: [],
            workers: [],
            stats: DEFAULT_STATS,
          },
    );
  }, []);

  const applyStateConfig = useCallback((config: AppConfig) => {
    setState((prev) =>
      prev
        ? { ...prev, config }
        : {
            config,
            rules: [],
            runs: [],
            cards: [],
            workers: [],
            stats: DEFAULT_STATS,
          },
    );
  }, []);

  const value = useMemo<HubContextValue>(
    () => ({
      page,
      setPage,
      baseUrl,
      token,
      setConnection,
      health,
      state,
      config: state ? parseAppConfig(state.config) : cloneConfig(DEFAULT_CONFIG),
      rules: state?.rules ?? [],
      online,
      live,
      lastError,
      lastUpdatedAt,
      refreshing,
      refresh,
      settingsOpen,
      setSettingsOpen,
      toasts,
      toast,
      dismissToast,
      applyStateRules,
      applyStateConfig,
    }),
    [
      page,
      baseUrl,
      token,
      setConnection,
      health,
      state,
      online,
      live,
      lastError,
      lastUpdatedAt,
      refreshing,
      refresh,
      settingsOpen,
      toasts,
      toast,
      dismissToast,
      applyStateRules,
      applyStateConfig,
    ],
  );

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error("useHub must be used within HubProvider");
  return ctx;
}
