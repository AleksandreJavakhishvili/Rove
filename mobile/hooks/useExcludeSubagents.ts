import KV from '@/lib/kv';
import { create } from 'zustand';

interface ExcludeSubagentsStore {
  excludeSubagents: boolean;
  _loaded: boolean;
  load(): Promise<void>;
  setExcludeSubagents(value: boolean): void;
}

const STORAGE_KEY = '@rove/exclude-subagents';

export const useExcludeSubagents = create<ExcludeSubagentsStore>((set, get) => ({
  excludeSubagents: false,
  _loaded: false,

  async load() {
    if (get()._loaded) return;
    set({ _loaded: true });
    try {
      const raw = await KV.getItemAsync(STORAGE_KEY);
      if (raw === 'true') set({ excludeSubagents: true });
    } catch {
      // Storage unavailable — use default.
    }
  },

  setExcludeSubagents(value) {
    set({ excludeSubagents: value });
    KV.setItemAsync(STORAGE_KEY, String(value)).catch(() => {});
  },
}));

// UUID pattern: 8-4-4-4-12 hex groups
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long hex string (git hash-like, 12+ chars) — catches worktree names like abc123def456
const HEX_RE = /^[0-9a-f]{12,}$/i;

/** Returns true when a session looks like a subagent, orphan, or system session:
 *  UUID/hash project name, a worktree path, or a .claude-mem observer session. */
export function isSubagentSession(session: { projectName: string; cwd: string }): boolean {
  return (
    UUID_RE.test(session.projectName) ||
    HEX_RE.test(session.projectName) ||
    session.cwd.includes('/.worktrees/') ||
    session.cwd.includes('/.claude-mem/')
  );
}
