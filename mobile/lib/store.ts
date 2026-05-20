import {
  fetchPendingPermissions,
  openEventsStream,
  type PendingPermissionSnapshot,
} from './bridge';
import KV from './kv';
import { useEffect } from 'react';
import { create } from 'zustand';

interface Settings {
  baseUrl: string;
  token: string;
  hydrated: boolean;
}

interface SettingsActions {
  load(): Promise<void>;
  setBaseUrl(url: string): Promise<void>;
  setToken(token: string): Promise<void>;
  reset(): Promise<void>;
}

type SettingsStore = Settings & SettingsActions;

const STORAGE_KEY = 'rove:settings:v1';

async function persist(state: Pick<Settings, 'baseUrl' | 'token'>): Promise<void> {
  await KV.setItemAsync(STORAGE_KEY, JSON.stringify(state));
}

export const useSettings = create<SettingsStore>((set, get) => ({
  baseUrl: '',
  token: '',
  hydrated: false,
  async load() {
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({ baseUrl: parsed.baseUrl ?? '', token: parsed.token ?? '', hydrated: true });
        return;
      }
    } catch (err) {
      console.warn('settings load failed', err);
    }
    set({ hydrated: true });
  },
  async setBaseUrl(url) {
    set({ baseUrl: url });
    await persist({ baseUrl: url, token: get().token });
  },
  async setToken(token) {
    set({ token });
    await persist({ baseUrl: get().baseUrl, token });
  },
  async reset() {
    set({ baseUrl: '', token: '' });
    await KV.removeItemAsync(STORAGE_KEY);
  },
}));

/** Convenience hook: ensures settings are loaded once on mount. */
export function useHydratedSettings(): SettingsStore {
  const store = useSettings();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

// ─── Preview prefs (per-session selected port + custom labels) ─────────────

interface PreviewPrefsState {
  hydrated: boolean;
  /** sessionId → port */
  selectedPort: Record<string, number>;
  /** sessionId → port → custom label */
  customLabels: Record<string, Record<number, string>>;
}

interface PreviewPrefsActions {
  load(): Promise<void>;
  setSelectedPort(sessionId: string, port: number): Promise<void>;
  setLabel(sessionId: string, port: number, label: string): Promise<void>;
  clearLabel(sessionId: string, port: number): Promise<void>;
}

type PreviewPrefsStore = PreviewPrefsState & PreviewPrefsActions;

const PREVIEW_PREFS_KEY = 'rove:preview-prefs:v1';

async function persistPreview(state: Pick<PreviewPrefsState, 'selectedPort' | 'customLabels'>): Promise<void> {
  await KV.setItemAsync(
    PREVIEW_PREFS_KEY,
    JSON.stringify({ selectedPort: state.selectedPort, customLabels: state.customLabels }),
  );
}

export const usePreviewPrefs = create<PreviewPrefsStore>((set, get) => ({
  hydrated: false,
  selectedPort: {},
  customLabels: {},
  async load() {
    try {
      const raw = await KV.getItemAsync(PREVIEW_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          selectedPort: parsed.selectedPort ?? {},
          customLabels: parsed.customLabels ?? {},
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('preview prefs load failed', err);
    }
    set({ hydrated: true });
  },
  async setSelectedPort(sessionId, port) {
    const selectedPort = { ...get().selectedPort, [sessionId]: port };
    set({ selectedPort });
    await persistPreview({ selectedPort, customLabels: get().customLabels });
  },
  async setLabel(sessionId, port, label) {
    const trimmed = label.trim().slice(0, 60);
    if (!trimmed) return get().clearLabel(sessionId, port);
    const per = { ...(get().customLabels[sessionId] ?? {}), [port]: trimmed };
    const customLabels = { ...get().customLabels, [sessionId]: per };
    set({ customLabels });
    await persistPreview({ selectedPort: get().selectedPort, customLabels });
  },
  async clearLabel(sessionId, port) {
    const existing = get().customLabels[sessionId];
    if (!existing || !(port in existing)) return;
    const per = { ...existing };
    delete per[port];
    const customLabels = { ...get().customLabels };
    if (Object.keys(per).length === 0) delete customLabels[sessionId];
    else customLabels[sessionId] = per;
    set({ customLabels });
    await persistPreview({ selectedPort: get().selectedPort, customLabels });
  },
}));

export function useHydratedPreviewPrefs(): PreviewPrefsStore {
  const store = usePreviewPrefs();
  useEffect(() => {
    if (!store.hydrated) void store.load();
  }, [store]);
  return store;
}

// ─── Pending permissions (cross-session) ──────────────────────────────────
//
// Lives at the app level (not per-screen) so the WebSocket stays connected as
// the user navigates between chats. Without this, /events disconnects every
// time the sessions list unmounts and any `permission_added` event fired while
// the user is inside a chat is lost — exactly the bug we're fixing.

export type PendingMap = Record<string, PendingPermissionSnapshot[]>;

interface PendingPermissionsState {
  byKey: PendingMap;
  connected: boolean;
}

interface PendingPermissionsActions {
  /** Open the bridge-wide events stream. Idempotent — repeated calls with the
   *  same connection key are no-ops. Restarts when baseUrl/token change. */
  ensureStreaming(baseUrl: string, token: string): void;
  /** Close the stream — called when the user signs out / changes bridge. */
  disconnect(): void;
  /** Optimistically drop a request the user just decided on, so the UI updates
   *  before the bridge's `permission_resolved` echo arrives. */
  removeOne(agent: string, sessionId: string, toolUseId: string): void;
}

type PendingPermissionsStore = PendingPermissionsState & PendingPermissionsActions;

function pendingKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

let currentStream: { close(): void } | null = null;
let currentConnectionKey: string | null = null;

export const usePendingPermissions = create<PendingPermissionsStore>((set, get) => ({
  byKey: {},
  connected: false,

  ensureStreaming(baseUrl: string, token: string) {
    if (!baseUrl) return;
    const connKey = `${baseUrl}::${token}`;
    if (currentConnectionKey === connKey && currentStream) return;
    // Settings changed — tear down the previous stream before opening a new one.
    if (currentStream) {
      currentStream.close();
      currentStream = null;
    }
    currentConnectionKey = connKey;
    set({ byKey: {}, connected: false });

    // Hydrate via HTTP first; the snapshot frame from /events will then
    // overwrite this with the authoritative server-side view.
    fetchPendingPermissions({ baseUrl, token })
      .then((list) => {
        if (currentConnectionKey !== connKey) return; // settings changed mid-fetch
        const next: PendingMap = {};
        for (const p of list) {
          const k = pendingKey(p.agent, p.sessionId);
          (next[k] ??= []).push(p);
        }
        set({ byKey: next });
      })
      .catch((err) => console.warn('[pending] hydrate failed', err));

    currentStream = openEventsStream({ baseUrl, token }, (msg) => {
      if (currentConnectionKey !== connKey) return;
      if (msg.type === 'permissions_snapshot') {
        const next: PendingMap = {};
        for (const p of msg.pending) {
          const k = pendingKey(p.agent, p.sessionId);
          (next[k] ??= []).push(p);
        }
        set({ byKey: next, connected: true });
      } else if (msg.type === 'permission_added') {
        const k = pendingKey(msg.pending.agent, msg.pending.sessionId);
        set((s) => ({
          byKey: { ...s.byKey, [k]: [...(s.byKey[k] ?? []), msg.pending] },
        }));
      } else if (msg.type === 'permission_resolved') {
        get().removeOne(msg.agent, msg.sessionId, msg.toolUseId);
      }
    });
  },

  disconnect() {
    if (currentStream) {
      currentStream.close();
      currentStream = null;
    }
    currentConnectionKey = null;
    set({ byKey: {}, connected: false });
  },

  removeOne(agent: string, sessionId: string, toolUseId: string) {
    const k = pendingKey(agent, sessionId);
    set((s) => {
      const list = (s.byKey[k] ?? []).filter((p) => p.toolUseId !== toolUseId);
      const byKey = { ...s.byKey };
      if (list.length === 0) delete byKey[k];
      else byKey[k] = list;
      return { byKey };
    });
  },
}));

/** Hook that starts the stream once settings are hydrated. Mount this once at
 *  the app root so the connection survives navigation. */
export function useEnsurePendingPermissionsStream(): void {
  const settings = useHydratedSettings();
  const ensure = usePendingPermissions((s) => s.ensureStreaming);
  const disconnect = usePendingPermissions((s) => s.disconnect);
  useEffect(() => {
    if (!settings.hydrated) return;
    if (!settings.baseUrl) {
      disconnect();
      return;
    }
    ensure(settings.baseUrl, settings.token);
  }, [settings.hydrated, settings.baseUrl, settings.token, ensure, disconnect]);
}
