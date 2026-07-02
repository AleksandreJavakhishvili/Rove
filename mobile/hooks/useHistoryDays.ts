import KV from '@/lib/kv';
import { create } from 'zustand';

interface HistoryDaysStore {
  historyDays: number;
  _loaded: boolean;
  load(): Promise<void>;
  setHistoryDays(days: number): void;
}

const STORAGE_KEY = '@rove/session-history-days';

export const useHistoryDays = create<HistoryDaysStore>((set, get) => ({
  historyDays: 30,
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
          set({ historyDays: parsed });
        }
      }
    } catch {
      // Storage unavailable — use default.
    }
  },

  setHistoryDays(days) {
    set({ historyDays: days });
    KV.setItemAsync(STORAGE_KEY, String(days)).catch(() => {});
  },
}));
