import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { sendApproval, type PendingPermissionSnapshot } from '@/lib/bridge';
import { useHydratedSettings, usePendingPermissions } from '@/lib/store';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

function busyKey(p: PendingPermissionSnapshot): string {
  return `${p.agent}:${p.sessionId}:${p.toolUseId}`;
}

/**
 * Shared permission-decision flow used by every approval surface (the
 * sessions-list chips and the in-chat cross-session tray). Owns a per-request
 * "busy" set so buttons disable while the round-trip is in flight, sends the
 * decision through the bridge, and optimistically drops the request from the
 * pending store — the bridge's `permission_resolved` echo confirms shortly,
 * but the user shouldn't stare at a stale row in the meantime.
 */
export function usePermissionDecision() {
  const settings = useHydratedSettings();
  const removePending = usePendingPermissions((s) => s.removeOne);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const decide = useCallback(
    async (p: PendingPermissionSnapshot, decision: PermissionDecision) => {
      const key = busyKey(p);
      setBusy((prev) => new Set(prev).add(key));
      try {
        await sendApproval(
          { baseUrl: settings.baseUrl, token: settings.token },
          p.agent,
          p.sessionId,
          p.toolUseId,
          decision,
        );
        removePending(p.agent, p.sessionId, p.toolUseId);
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
    [settings.baseUrl, settings.token, removePending],
  );

  const isBusy = useCallback((p: PendingPermissionSnapshot) => busy.has(busyKey(p)), [busy]);

  return { decide, isBusy };
}
