import KV from '@/lib/kv';
import { create } from 'zustand';

interface DefaultCollapsedStore {
  defaultCollapsed: boolean;
  _loaded: boolean;
  load(): Promise<void>;
  setDefaultCollapsed(value: boolean): void;
}

const STORAGE_KEY = '@rove/repos-collapsed-default';

export const useDefaultCollapsed = create<DefaultCollapsedStore>((set, get) => ({
  defaultCollapsed: false,
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw === 'true') set({ defaultCollapsed: true });
    } catch {
      // Storage unavailable — use default.
    }
  },

  setDefaultCollapsed(value) {
    set({ defaultCollapsed: value });
    KV.setItemAsync(STORAGE_KEY, String(value)).catch(() => {});
  },
}));
