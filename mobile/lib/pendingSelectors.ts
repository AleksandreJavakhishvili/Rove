import type { PendingPermissionSnapshot } from './bridge';

/** Map of `${agent}:${sessionId}` → that session's pending permission requests. */
export type PendingMap = Record<string, PendingPermissionSnapshot[]>;

function pendingKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

/**
 * Flatten the cross-session pending map down to just the requests that do
 * *not* belong to the focused session, sorted oldest-first by `createdAt`.
 *
 * The in-chat cross-session approval surface (whisper / badge / tray) shows
 * only *other* sessions' requests — the focused session keeps using the
 * full-screen ApprovalSheet. Excluding the focused key here is what makes a
 * tray tap unambiguous: it can never act on the chat you're looking at.
 *
 * Lives in its own KV-free module (no zustand/native imports) so it's
 * trivially unit-testable and can be memoized by callers against `byKey`.
 */
export function selectOthersPending(
  byKey: PendingMap,
  currentAgent: string,
  currentSessionId: string,
): PendingPermissionSnapshot[] {
  const focusedKey = pendingKey(currentAgent, currentSessionId);
  const out: PendingPermissionSnapshot[] = [];
  for (const [k, list] of Object.entries(byKey)) {
    if (k === focusedKey) continue;
    out.push(...list);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
