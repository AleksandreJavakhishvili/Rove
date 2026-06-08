import type { PendingRequestSnapshot } from './bridge';

/** A pending request tagged (mobile-side) with the bridge it came from. The
 *  wire snapshot has no bridgeId — the store stamps it per `/events` stream. */
export type PendingItem = PendingRequestSnapshot & { bridgeId: string };

/** Map of `${bridgeId}:${agent}:${sessionId}` → that session's pending requests. */
export type PendingMap = Record<string, PendingItem[]>;

export function pendingKey(bridgeId: string, agent: string, sessionId: string): string {
  return `${bridgeId}:${agent}:${sessionId}`;
}

/**
 * Flatten the cross-session pending map down to just the requests that do
 * *not* belong to the focused session, sorted oldest-first by `createdAt`.
 *
 * "Focused" is now scoped by bridge too: the same `(agent, sessionId)` on a
 * different machine is still "other". The in-chat cross-session surface
 * (whisper / badge / tray) shows only other sessions' requests — the focused
 * session keeps using the full-screen PermissionSheet.
 *
 * Lives in its own KV-free module (no zustand/native imports) so it's
 * trivially unit-testable and can be memoized by callers against `byKey`.
 */
export function selectOthersPending(
  byKey: PendingMap,
  currentBridgeId: string,
  currentAgent: string,
  currentSessionId: string,
): PendingItem[] {
  const focusedKey = pendingKey(currentBridgeId, currentAgent, currentSessionId);
  const out: PendingItem[] = [];
  for (const [k, list] of Object.entries(byKey)) {
    if (k === focusedKey) continue;
    out.push(...list);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
