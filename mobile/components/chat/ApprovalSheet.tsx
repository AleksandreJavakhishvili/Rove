import { fontFamily, fontSize, radius, space, useTheme } from '@/theme';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export interface PendingApproval {
  toolUseId: string;
  tool: string;
  input: unknown;
}

interface ApprovalSheetProps {
  approval: PendingApproval | null;
  onDecision: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

function summarize(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'Bash':
      return String(o.command ?? '');
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return String(o.file_path ?? '');
    case 'WebFetch':
      return String(o.url ?? '');
    default:
      try {
        return JSON.stringify(o, null, 2).slice(0, 800);
      } catch {
        return '';
      }
  }
}

function dangerLevel(tool: string, input: unknown): 'low' | 'medium' | 'high' {
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

export function ApprovalSheet({ approval, onDecision }: ApprovalSheetProps) {
  const t = useTheme();
  if (!approval) return null;
  const danger = dangerLevel(approval.tool, approval.input);
  const dangerColor =
    danger === 'high' ? t.status.danger : danger === 'medium' ? t.status.warning : t.accent.primary;

  return (
    <Modal animationType="slide" transparent onRequestClose={() => onDecision('deny')}>
      <View style={[styles.backdrop, { backgroundColor: t.surface.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface.raised }]}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
          <Text style={[styles.title, { color: t.text.primary }]}>
            Allow <Text style={{ color: dangerColor }}>{approval.tool}</Text>?
          </Text>
          <Text style={[styles.subtitle, { color: t.text.secondary }]}>
            {danger === 'high'
              ? 'This command looks destructive — review carefully.'
              : 'Your agent wants to run a tool that modifies state.'}
          </Text>
          <ScrollView style={[styles.argsBox, { borderColor: t.border.subtle }]}>
            <Text selectable style={[styles.argsText, { color: t.text.primary }]}>
              {summarize(approval.tool, approval.input)}
            </Text>
          </ScrollView>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => onDecision('deny')}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: t.status.dangerBg, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.btnLabel, { color: t.status.danger }]}>Deny</Text>
            </Pressable>
            <Pressable
              onPress={() => onDecision('allow_always')}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: t.surface.pressed, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.btnLabel, { color: t.text.primary }]}>Always</Text>
            </Pressable>
            <Pressable
              onPress={() => onDecision('allow')}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: t.accent.primary, opacity: pressed ? 0.85 : 1 },
              ]}>
              <Text style={[styles.btnLabel, { color: t.accent.fg }]}>Allow</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: space[5],
    paddingBottom: space[8] + 4,
    paddingTop: space[2],
    gap: space[3],
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 6,
    opacity: 0.4,
  },
  title: { fontSize: fontSize['4xl'] - 2, fontWeight: '700' },
  subtitle: { fontSize: fontSize.md },
  argsBox: { maxHeight: 220, borderWidth: 1, borderRadius: radius.lg + 2, padding: space[3] - 2 },
  argsText: { fontFamily: fontFamily.mono, fontSize: fontSize.base, lineHeight: 18 },
  buttons: { flexDirection: 'row', gap: space[2], marginTop: 4 },
  btn: { flex: 1, paddingVertical: space[3] + 2, borderRadius: radius.xl, alignItems: 'center' },
  btnLabel: { fontSize: fontSize.lg, fontWeight: '600' },
});
