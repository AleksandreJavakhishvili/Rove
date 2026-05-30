import { usePendingPermissions } from '@/lib/store';
import { selectOthersPending } from '@/lib/pendingSelectors';
import { fontSize, radius, space, useTheme } from '@/theme';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  const t = useTheme();
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
      {/* TEMPORARY Phase-2 badge — replaced by the draggable, edge-snapping
          ApprovalBadge in Phase 3. Bottom-right, opens the tray on tap. */}
      <Pressable
        onPress={() => setTrayOpen(true)}
        style={[styles.badge, { backgroundColor: t.accent.primary }]}
        accessibilityRole="button"
        accessibilityLabel={`${count} session${count === 1 ? '' : 's'} waiting for approval`}>
        <View style={[styles.dot, { backgroundColor: t.accent.fg }]} />
        <Text style={[styles.badgeLabel, { color: t.accent.fg }]}>{count} waiting</Text>
      </Pressable>
      <ApprovalTray open={trayOpen} requests={others} onClose={() => setTrayOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    right: space[4],
    bottom: 96,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeLabel: { fontSize: fontSize.md, fontWeight: '700' },
});
