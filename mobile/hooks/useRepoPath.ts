import KV from '@/lib/kv';
import { create } from 'zustand';

interface RepoPathStore {
  repoPath: string;
  _loaded: boolean;
  load(): Promise<void>;
  setRepoPath(path: string): void;
}

const STORAGE_KEY = '@rove/repo-path';
const DEFAULT_PATH = '';

export const useRepoPath = create<RepoPathStore>((set, get) => ({
  repoPath: DEFAULT_PATH,
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      // Empty string means "no filter" — treat it as a valid saved value.
      if (raw !== null) set({ repoPath: raw.trim() });
    } catch {
      // Storage unavailable — use default.
    }
  },

  setRepoPath(path) {
    const normalized = path.trim().replace(/\/+$/, '');
    set({ repoPath: normalized });
    KV.setItemAsync(STORAGE_KEY, normalized).catch(() => {});
  },
}));

/** Returns true when a session's cwd falls under the configured repo root.
 *  An empty repoPath disables filtering (all sessions pass). */
export function matchesRepoPath(cwd: string, repoPath: string): boolean {
  if (!repoPath) return true;
  const base = repoPath.replace(/\/+$/, '');
  return cwd === base || cwd.startsWith(base + '/');
}
