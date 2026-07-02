import KV from '@/lib/kv';
import { create } from 'zustand';

export type ViewMode = 'flat' | 'grouped-alpha' | 'grouped-recency';

interface ViewModeStore {
  viewMode: ViewMode;
  _loaded: boolean;
  load(): Promise<void>;
  setViewMode(mode: ViewMode): void;
}

const STORAGE_KEY = '@rove/session-view-mode';

export const useViewMode = create<ViewModeStore>((set, get) => ({
  viewMode: 'flat',
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw === 'flat' || raw === 'grouped-alpha' || raw === 'grouped-recency') {
        set({ viewMode: raw });
      }
    } catch {
      // Storage unavailable — use default.
    }
  },

  setViewMode(mode) {
    set({ viewMode: mode });
    KV.setItemAsync(STORAGE_KEY, mode).catch(() => {});
  },
}));
