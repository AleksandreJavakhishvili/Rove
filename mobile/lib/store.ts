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
