import { usePermissionDecision } from '@/lib/permissions';
import type { PendingPermissionSnapshot } from '@/lib/bridge';
import { dangerLevel, summarizeToolInput } from '@/lib/toolSummary';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

interface ApprovalTrayProps {
  open: boolean;
  requests: PendingPermissionSnapshot[];
  onClose: () => void;
}

/** Last path segment of a cwd, so a row reads `codex · my-repo` rather than
 *  the full absolute path. Falls back to the agent kind alone when cwd is null. */
function repoLabel(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function dangerColor(level: ReturnType<typeof dangerLevel>, t: Theme): string {
  return level === 'high' ? t.status.danger : level === 'medium' ? t.status.warning : t.accent.primary;
}

function Row({
  p,
  busy,
  onDecide,
  onOpen,
}: {
  p: PendingPermissionSnapshot;
  busy: boolean;
  onDecide: (decision: 'allow' | 'allow_always' | 'deny') => void;
  onOpen: () => void;
}) {
  const t = useTheme();
  const summary = summarizeToolInput(p.tool, p.input);
  const level = dangerLevel(p.tool, p.input);
  const accent = dangerColor(level, t);
  const repo = repoLabel(p.cwd);
  const owner = repo ? `${p.agent} · ${repo}` : p.agent;

  return (
    <View style={[styles.row, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
      <View style={styles.rowHead}>
        <View style={[styles.dangerDot, { backgroundColor: accent }]} />
        <Text style={[styles.owner, { color: t.text.secondary }]} numberOfLines={1}>
          {owner}
        </Text>
        <Text style={[styles.tool, { color: accent }]}>{p.tool}</Text>
      </View>
      {summary ? (
        <Text style={[styles.summary, { color: t.text.primary }]} numberOfLines={3}>
          {summary}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          disabled={busy}
          onPress={() => onDecide('allow')}
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: pressed ? t.accent.pressed : t.accent.primary, opacity: busy ? 0.5 : 1 },
          ]}>
          <Text style={[styles.btnLabel, { color: t.accent.fg }]}>Allow</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => onDecide('allow_always')}
          style={({ pressed }) => [
            styles.btn,
            {
              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.border.default,
              opacity: busy ? 0.5 : 1,
            },
          ]}>
          <Text style={[styles.btnLabel, { color: t.text.primary }]}>Always</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => onDecide('deny')}
          style={({ pressed }) => [
            styles.btn,
            {
              backgroundColor: pressed ? t.status.dangerCardBg : 'transparent',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.status.danger,
              opacity: busy ? 0.5 : 1,
            },
          ]}>
          <Text style={[styles.btnLabel, { color: t.status.danger }]}>Deny</Text>
        </Pressable>
      </View>
      <Pressable onPress={onOpen} hitSlop={6}>
        <Text style={[styles.open, { color: t.accent.primary }]}>Open session for context →</Text>
      </Pressable>
    </View>
  );
}

/**
 * Bottom-sheet listing every *other* session's pending permission request.
 * Overlays the chat without unmounting it, so dismissing returns the user to
 * their exact scroll position and draft. Each row identifies the owning
 * session/repo, tool, input summary, and risk so the user never approves blind.
 */
export function ApprovalTray({ open, requests, onClose }: ApprovalTrayProps) {
  const t = useTheme();
  const { decide, isBusy } = usePermissionDecision();

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: t.surface.scrim }]} onPress={onClose}>
        {/* Inner Pressable swallows taps so pressing a row doesn't dismiss. */}
        <Pressable style={[styles.sheet, { backgroundColor: t.surface.base }]} onPress={() => {}}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
          <Text style={[styles.title, { color: t.text.primary }]}>
            {requests.length > 0 ? `Waiting on you · ${requests.length}` : 'All caught up'}
          </Text>
          {requests.length === 0 ? (
            <Text style={[styles.empty, { color: t.text.secondary }]}>
              No other sessions are waiting for approval.
            </Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={{ gap: space[3] }}>
              {requests.map((p) => (
                <Row
                  key={p.toolUseId}
                  p={p}
                  busy={isBusy(p)}
                  onDecide={(d) => decide(p, d)}
                  onOpen={() => {
                    onClose();
                    router.push(`/sessions/${p.agent}/${p.sessionId}`);
                  }}
                />
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: space[4],
    paddingBottom: space[8] + 4,
    paddingTop: space[2],
    maxHeight: '80%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10, opacity: 0.4 },
  title: { fontSize: fontSize['2xl'], fontWeight: '700', marginBottom: space[3] },
  empty: { fontSize: fontSize.md, paddingBottom: space[6] },
  list: { flexGrow: 0 },
  row: { borderWidth: 1, borderRadius: radius.lg + 2, padding: space[3], gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dangerDot: { width: 8, height: 8, borderRadius: 4 },
  owner: { flex: 1, fontSize: fontSize.sm },
  tool: { fontSize: fontSize.sm, fontWeight: '700' },
  summary: { fontFamily: fontFamily.mono, fontSize: fontSize.base, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space[2], marginTop: 2 },
  btn: { flex: 1, paddingVertical: space[2] + 2, borderRadius: radius.lg, alignItems: 'center' },
  btnLabel: { fontSize: fontSize.md, fontWeight: '600' },
  open: { fontSize: fontSize.sm, fontWeight: '500', marginTop: 2 },
});
