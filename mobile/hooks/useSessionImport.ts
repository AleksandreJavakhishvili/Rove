import { create } from 'zustand';
import { fetchSessionsPage } from '@/lib/bridge';
import { sessionDb } from '@/lib/sessionDb';
import { useHistoryDays } from '@/hooks/useHistoryDays';
import { bridgeToConfig, type Bridge } from '@/lib/bridges';
import type { TaggedSession } from '@/lib/aggregator';
import KV from '@/lib/kv';

const importKey = (bridgeId: string) => `@rove/last-import/${bridgeId}`;

type ImportStatus = 'idle' | 'running' | 'done' | 'error';

interface SessionImportStore {
  status: ImportStatus;
  loaded: number;
  total: number;
  /** Pass force:true to skip delta and re-import the full history window. */
  runImport(bridge: Bridge, opts?: { force?: boolean }): Promise<void>;
  resetToIdle(): void;
}

export const useSessionImport = create<SessionImportStore>((set, get) => ({
  status: 'idle',
  loaded: 0,
  total: 0,

  async runImport(bridge, opts) {
    if (get().status === 'running') return;
    set({ status: 'running', loaded: 0, total: 0 });
    try {
      await useHistoryDays.getState().load();
      const { historyDays } = useHistoryDays.getState();
      const now = Date.now();
      const cutoff = now - historyDays * 86_400_000;
      const lastImportRaw = opts?.force ? null : await KV.getItemAsync(importKey(bridge.id));
      const lastImport = lastImportRaw ? Number(lastImportRaw) : null;
      const since = lastImport ?? cutoff;
      await sessionDb.purgeOlderThan(bridge.id, cutoff);

      const PAGE_SIZE = 100;
      let offset = 0;
      const cfg = bridgeToConfig(bridge);
      while (true) {
        const page = await fetchSessionsPage(cfg, since, PAGE_SIZE, offset);
        if (page.sessions.length === 0) break;
        const tagged: TaggedSession[] = page.sessions
          .map((s) => ({ ...s, bridgeId: bridge.id }));
        await sessionDb.upsert(bridge.id, tagged);
        const newLoaded = get().loaded + page.sessions.length;
        set({ loaded: newLoaded, total: page.total });
        offset += PAGE_SIZE;
        if (offset >= page.total) break;
      }

      await KV.setItemAsync(importKey(bridge.id), String(Date.now()));
      set({ status: 'done' });
      setTimeout(() => get().resetToIdle(), 3000);
    } catch {
      set({ status: 'error' });
    }
  },

  resetToIdle() {
    set({ status: 'idle', loaded: 0, total: 0 });
  },
}));
