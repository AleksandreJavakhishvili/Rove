/**
 * Shared tool-input summary + risk heuristics for every permission surface.
 *
 * These were previously duplicated across the sessions-list approval chips
 * (`app/index.tsx`) and the foreground `ApprovalSheet`. The cross-session
 * approval tray needs the exact same one-line summary and danger cue, so the
 * logic lives here once — a user who learns "red = destructive" from the
 * ApprovalSheet should see the identical signal in the tray.
 */

export type DangerLevel = 'low' | 'medium' | 'high';

/**
 * Produce a tight one-line description of a tool invocation for inline
 * approval cards. Optimized for the tools Claude actually prompts on — Bash
 * and the file-mutation set are the long tail; everything else falls back to
 * a compact JSON peek.
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'Bash' && typeof o.command === 'string') return o.command;
  if (
    (tool === 'Read' ||
      tool === 'Edit' ||
      tool === 'Write' ||
      tool === 'MultiEdit' ||
      tool === 'NotebookEdit') &&
    typeof o.file_path === 'string'
  ) {
    return o.file_path;
  }
  if (tool === 'WebFetch' && typeof o.url === 'string') return o.url;
  if (tool === 'WebSearch' && typeof o.query === 'string') return o.query;
  try {
    const j = JSON.stringify(o);
    return j.length > 120 ? j.slice(0, 117) + '…' : j;
  } catch {
    return '';
  }
}

/**
 * Coarse risk classification used to color approval rows. `high` flags the
 * obviously-destructive Bash commands (`rm -rf`, force-push, sudo); state
 * mutations are `medium`; reads and unknown tools are `low`.
 */
export function dangerLevel(tool: string, input: unknown): DangerLevel {
  if (tool === 'Bash') {
    const cmd = String((input as any)?.command ?? '');
    if (/\brm\s+-rf\b/.test(cmd) || /git\s+push\s+(-f|--force)/.test(cmd) || /sudo\b/.test(cmd)) {
      return 'high';
    }
    return 'medium';
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return 'medium';
  if (tool === 'WebFetch') return 'medium';
  return 'low';
}
