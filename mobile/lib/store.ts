import KV from 'expo-sqlite/kv-store';
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
