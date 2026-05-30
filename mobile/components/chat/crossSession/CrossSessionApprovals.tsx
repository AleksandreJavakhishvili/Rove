import { usePendingPermissions } from '@/lib/store';
import { selectOthersPending } from '@/lib/pendingSelectors';
import { useMemo, useState } from 'react';
import { ApprovalBadge } from './ApprovalBadge';
import { ApprovalTray } from './ApprovalTray';

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
 * `count === 0` is the single teardown condition: no badge, no tray.
 */
export function CrossSessionApprovals({ currentAgent, currentSessionId }: CrossSessionApprovalsProps) {
  const byKey = usePendingPermissions((s) => s.byKey);
  const [trayOpen, setTrayOpen] = useState(false);

  const others = useMemo(
    () => selectOthersPending(byKey, currentAgent, currentSessionId),
    [byKey, currentAgent, currentSessionId],
  );
  const count = others.length;

  // Nothing pending elsewhere → render nothing and make sure the tray is shut.
  if (count === 0) {
    return trayOpen ? <ApprovalTray open={false} requests={others} onClose={() => setTrayOpen(false)} /> : null;
  }

  return (
    <>
      <ApprovalBadge count={count} onPress={() => setTrayOpen(true)} />
      <ApprovalTray open={trayOpen} requests={others} onClose={() => setTrayOpen(false)} />
    </>
  );
}
