import type { PendingRequestSnapshot } from '@/lib/bridge';
import { selectOthersPending } from '@/lib/pendingSelectors';
import { usePendingRequests } from '@/lib/store';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GestureType } from 'react-native-gesture-handler';
import { RequestBadge } from './RequestBadge';
import { RequestTray } from './RequestTray';
import { RequestWhisper } from './RequestWhisper';

interface CrossSessionRequestsProps {
  currentAgent: string;
  currentSessionId: string;
  /** The bridge the focused chat lives on — so the focused session is excluded
   *  per machine (same agent/id on another machine is still "other"). */
  currentBridgeId: string;
  /** The chat pager's pan gesture, forwarded to the draggable badge so a
   *  re-snap drag doesn't flip the page. See RequestBadge. */
  pagerGestureRef?: React.MutableRefObject<GestureType | undefined>;
}

/**
 * Controller for the in-chat cross-session approval surface. Mounted once per
 * chat screen. Subscribes to the app-level pending-permissions store, derives
 * the requests that belong to *other* sessions (the focused session keeps its
 * own PermissionSheet), and drives the whisper → badge → tray flow.
 *
 * `count === 0` is the single teardown condition: no badge, no tray, no whisper.
 */
export function CrossSessionRequests({
  currentAgent,
  currentSessionId,
  currentBridgeId,
  pagerGestureRef,
}: CrossSessionRequestsProps) {
  const byKey = usePendingRequests((s) => s.byKey);
  const [trayOpen, setTrayOpen] = useState(false);
  const [whisperId, setWhisperId] = useState<string | null>(null);
  // toolUseIds we've already announced, so re-renders don't re-whisper old
  // requests. Seeded silently on first run so navigating *into* a chat with
  // requests already pending shows the badge, not a whisper for stale items.
  const seen = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  const others = useMemo(
    () => selectOthersPending(byKey, currentBridgeId, currentAgent, currentSessionId),
    [byKey, currentBridgeId, currentAgent, currentSessionId],
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
  const whisper: PendingRequestSnapshot | null = whisperId
    ? others.find((p) => p.toolUseId === whisperId) ?? null
    : null;

  const openTray = () => {
    setWhisperId(null);
    setTrayOpen(true);
  };

  if (count === 0) {
    // Drained — make sure a left-open tray closes; render nothing otherwise.
    return trayOpen ? (
      <RequestTray open={false} requests={others} onClose={() => setTrayOpen(false)} />
    ) : null;
  }

  return (
    <>
      <RequestWhisper request={whisper} onPress={openTray} onDismiss={() => setWhisperId(null)} />
      <RequestBadge count={count} onPress={openTray} pagerGestureRef={pagerGestureRef} />
      <RequestTray open={trayOpen} requests={others} onClose={() => setTrayOpen(false)} />
    </>
  );
}
