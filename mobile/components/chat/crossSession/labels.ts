import type { PendingRequestSnapshot } from '@/lib/bridge';

/** Last path segment of a cwd, so a request reads `codex · my-repo` rather
 *  than the full absolute path. Null when cwd is unavailable. */
export function repoLabel(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** `agent · repo` when a cwd is known, otherwise just the agent kind. */
export function ownerLabel(p: PendingRequestSnapshot): string {
  const repo = repoLabel(p.cwd);
  return repo ? `${p.agent} · ${repo}` : p.agent;
}
