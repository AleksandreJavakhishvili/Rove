import { lookupToolLabel } from '@/components/takeover/toolLabels';
import { dangerLevel } from '@/lib/toolSummary';
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
  /**
   * When true, suppress the "Always allow" button — the user is forced to
   * decide on every call. Wired to the Settings "Always ask before each
   * capture" sub-option for visual-feedback tools (preview-takeover
   * Phase 0). Independent of allow-always rules already cached from
   * previous sessions; those live in the bridge and are unaffected.
   */
  suppressAllowAlways?: boolean;
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

export function ApprovalSheet({ approval, onDecision, suppressAllowAlways }: ApprovalSheetProps) {
  const t = useTheme();
  if (!approval) return null;
  const danger = dangerLevel(approval.tool, approval.input);
  const dangerColor =
    danger === 'high' ? t.status.danger : danger === 'medium' ? t.status.warning : t.accent.primary;

  // Preview-takeover Phase 2 — visual-feedback tools render with
  // friendly copy ("Allow Claude to view your live preview?") instead
  // of the raw MCP tool name. Falls back to the default rendering for
  // any unrecognised tool.
  const friendly = lookupToolLabel(approval.tool);
  const titleLabel = friendly?.label ?? approval.tool;

  return (
    <Modal animationType="slide" transparent onRequestClose={() => onDecision('deny')}>
      <View style={[styles.backdrop, { backgroundColor: t.surface.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface.raised }]}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
          <Text style={[styles.title, { color: t.text.primary }]}>
            Allow <Text style={{ color: dangerColor }}>{titleLabel}</Text>?
          </Text>
          <Text style={[styles.subtitle, { color: t.text.secondary }]}>
            {friendly?.summary ??
              (danger === 'high'
                ? 'This command looks destructive — review carefully.'
                : 'Your agent wants to run a tool that modifies state.')}
          </Text>
          {friendly ? null : (
            <ScrollView style={[styles.argsBox, { borderColor: t.border.subtle }]}>
              <Text selectable style={[styles.argsText, { color: t.text.primary }]}>
                {summarize(approval.tool, approval.input)}
              </Text>
            </ScrollView>
          )}
          <View style={styles.buttons}>
            <Pressable
              onPress={() => onDecision('deny')}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: t.status.dangerBg, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.btnLabel, { color: t.status.danger }]}>Deny</Text>
            </Pressable>
            {suppressAllowAlways ? null : (
              <Pressable
                onPress={() => onDecision('allow_always')}
                style={({ pressed }) => [
                  styles.btn,
                  { backgroundColor: t.surface.pressed, opacity: pressed ? 0.7 : 1 },
                ]}>
                <Text style={[styles.btnLabel, { color: t.text.primary }]}>Always</Text>
              </Pressable>
            )}
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
