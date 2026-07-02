import KV from '@/lib/kv';
import type { TaggedSession } from '@/lib/aggregator';
import type { AgentKind } from '@/lib/types';
import { create } from 'zustand';

export type FilterSpec =
  | { kind: 'status';  value: 'live-bridge' | 'live-desktop' | 'idle' }
  | { kind: 'repo';    value: string }
  | { kind: 'machine'; value: string }
  | { kind: 'age';     value: number }
  | { kind: 'agent';   value: AgentKind }
  | { kind: 'name';    value: string }
  | { kind: 'preset';  value: 'observers' | 'subagents' };

const STORAGE_KEY = '@rove/session-filters';

const OBSERVER_RE = /\bobserver\b/i;
const SUBAGENT_RE = /\b(subagent|sub-agent|sub agent|\(sub\))\b/i;

export function sessionMatchesFilter(session: TaggedSession, filter: FilterSpec): boolean {
  const title = session.label ?? session.projectName;
  switch (filter.kind) {
    case 'status':
      if (filter.value === 'idle') {
        return session.status !== 'live-bridge' && session.status !== 'live-desktop';
      }
      return session.status === filter.value;
    case 'repo':
      return session.projectName === filter.value;
    case 'machine':
      return session.bridgeId === filter.value;
    case 'age':
      return Date.now() - session.lastModified > filter.value * 86_400_000;
    case 'agent':
      return session.agent === filter.value;
    case 'name':
      return title.toLowerCase().includes(filter.value.toLowerCase());
    case 'preset':
      if (filter.value === 'observers') return OBSERVER_RE.test(title);
      if (filter.value === 'subagents') return SUBAGENT_RE.test(title);
      return false;
  }
}

interface SessionFiltersStore {
  filters: FilterSpec[];
  _loaded: boolean;
  /** Call once per app session to hydrate from KV. No-ops after first call. */
  load(): Promise<void>;
  addFilter(spec: FilterSpec): void;
  removeFilter(index: number): void;
  clearFilters(): void;
  applyFilters(sessions: TaggedSession[]): TaggedSession[];
}

export const useSessionFilters = create<SessionFiltersStore>((set, get) => ({
  filters: [],
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) set({ filters: parsed as FilterSpec[] });
      }
    } catch {
      // Storage unavailable — proceed with empty filters.
    }
  },

  addFilter(spec) {
    const next = [...get().filters, spec];
    set({ filters: next });
    KV.setItemAsync(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  },

  removeFilter(index) {
    const next = get().filters.filter((_, i) => i !== index);
    set({ filters: next });
    KV.setItemAsync(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  },

  clearFilters() {
    set({ filters: [] });
    KV.setItemAsync(STORAGE_KEY, JSON.stringify([])).catch(() => {});
  },

  applyFilters(sessions) {
    const { filters } = get();
    if (filters.length === 0) return sessions;
    return sessions.filter((s) => !filters.some((f) => sessionMatchesFilter(s, f)));
  },
}));

// Convenience re-export so existing consumers keep the same import path.
export type { SessionFiltersStore as UseSessionFiltersReturn };
