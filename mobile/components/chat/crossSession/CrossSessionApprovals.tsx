import type { PendingPermissionSnapshot } from '@/lib/bridge';
import { selectOthersPending } from '@/lib/pendingSelectors';
import { usePendingPermissions } from '@/lib/store';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBadge } from './ApprovalBadge';
import { ApprovalTray } from './ApprovalTray';
import { ApprovalWhisper } from './ApprovalWhisper';

interface CrossSessionApprovalsProps {
  currentAgent: string;
  currentSessionId: string;
}

/**
 * Controller for the in-chat cross-session approval surface. Mounted once per
 * chat screen. Subscribes to the app-level pending-permissions store, derives
 * the requests that belong to *other* sessions (the focused session keeps its
 * own ApprovalSheet), and drives the whisper → badge → tray flow.
 *
 * `count === 0` is the single teardown condition: no badge, no tray, no whisper.
 */
export function CrossSessionApprovals({ currentAgent, currentSessionId }: CrossSessionApprovalsProps) {
  const byKey = usePendingPermissions((s) => s.byKey);
  const [trayOpen, setTrayOpen] = useState(false);
  const [whisperId, setWhisperId] = useState<string | null>(null);
  // toolUseIds we've already announced, so re-renders don't re-whisper old
  // requests. Seeded silently on first run so navigating *into* a chat with
  // requests already pending shows the badge, not a whisper for stale items.
  const seen = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  const others = useMemo(
    () => selectOthersPending(byKey, currentAgent, currentSessionId),
    [byKey, currentAgent, currentSessionId],
  );
  const count = others.length;

  useEffect(() => {
    const liveIds = new Set(others.map((p) => p.toolUseId));
    for (const id of seen.current) if (!liveIds.has(id)) seen.current.delete(id);
    const fresh = others.filter((p) => !seen.current.has(p.toolUseId));
    fresh.forEach((p) => seen.current.add(p.toolUseId));
    if (!initialized.current) {
      initialized.current = true;
      return; // seed only; never whisper for what was already pending on mount
    }
    // Newest fresh arrival (others is sorted oldest-first). Don't whisper while
    // the tray is open — the user is already looking at the full list.
    if (fresh.length > 0 && !trayOpen) setWhisperId(fresh[fresh.length - 1].toolUseId);
  }, [others, trayOpen]);

  // The whisper resolves against live data, so a request approved elsewhere (or
  // drained to zero) makes the banner dismiss itself with no extra bookkeeping.
  const whisper: PendingPermissionSnapshot | null = whisperId
    ? others.find((p) => p.toolUseId === whisperId) ?? null
    : null;

  const openTray = () => {
    setWhisperId(null);
    setTrayOpen(true);
  };

  if (count === 0) {
    // Drained — make sure a left-open tray closes; render nothing otherwise.
    return trayOpen ? (
      <ApprovalTray open={false} requests={others} onClose={() => setTrayOpen(false)} />
    ) : null;
  }

  return (
    <>
      <ApprovalWhisper request={whisper} onPress={openTray} onDismiss={() => setWhisperId(null)} />
      <ApprovalBadge count={count} onPress={openTray} />
      <ApprovalTray open={trayOpen} requests={others} onClose={() => setTrayOpen(false)} />
    </>
  );
}
