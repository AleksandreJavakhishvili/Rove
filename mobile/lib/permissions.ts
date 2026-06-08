import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { sendApproval } from '@/lib/bridge';
import { bridgeToConfig, useBridgesStore } from '@/lib/bridges';
import { usePendingRequests } from '@/lib/store';
import type { PendingItem } from '@/lib/pendingSelectors';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

function busyKey(p: PendingItem): string {
  return `${p.bridgeId}:${p.agent}:${p.sessionId}:${p.toolUseId}`;
}

/**
 * Shared permission-decision flow used by every approval surface (the
 * sessions-list chips and the in-chat cross-session tray). Owns a per-request
 * "busy" set so buttons disable while the round-trip is in flight, sends the
 * decision through the bridge, and optimistically drops the request from the
 * pending store — the bridge's `request_resolved` echo confirms shortly,
 * but the user shouldn't stare at a stale row in the meantime.
 */
export function usePermissionDecision() {
  const removePending = usePendingRequests((s) => s.removeOne);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const decide = useCallback(
    async (p: PendingItem, decision: PermissionDecision) => {
      const key = busyKey(p);
      // Route the decision to the bridge the request came from — not the active
      // one — so a cross-machine approval lands on the right host.
      const bridge = useBridgesStore.getState().bridges.find((b) => b.id === p.bridgeId);
      if (!bridge) {
        Alert.alert('Approval failed', 'That machine is no longer configured.');
        return;
      }
      setBusy((prev) => new Set(prev).add(key));
      try {
        await sendApproval(bridgeToConfig(bridge), p.agent, p.sessionId, p.toolUseId, decision);
        removePending(p.bridgeId, p.agent, p.sessionId, p.toolUseId);
      } catch (err) {
        Alert.alert('Approval failed', String((err as Error).message ?? err));
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [removePending],
  );

  const isBusy = useCallback((p: PendingItem) => busy.has(busyKey(p)), [busy]);

  return { decide, isBusy };
}
