import { fontSize, radius, space, useTheme } from '@/theme';
import { HANDOFF_NOTE_MAX_LEN } from '@/lib/types';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

interface HandoffSheetProps {
  visible: boolean;
  /** Agent-supplied prose — e.g. "Please log in to /admin and dismiss
   *  any onboarding modal." Already capped server-side by the
   *  `HANDOFF_INSTRUCTIONS_MAX_LEN` Zod constraint. */
  instructions: string;
  /** Optional sub-line: "Will open: /admin" when the agent suggested
   *  a path. */
  suggestedPath?: string;
  onOpenPreview: () => void;
  onSkip: (args?: { note?: string }) => void;
  onCancel: () => void;
}

/**
 * Bottom-sheet modal the controller shows when an agent calls
 * `prepare_preview`. Three actions:
 *  - "Open Preview" — primary; triggers `open_preview_tapped` in the
 *    reducer, which morphs the sheet into the `<HandoffPill>` and
 *    drives the pager + WebView setup.
 *  - "Skip" — opens a one-line note input then sends `skip_tapped`.
 *  - "Cancel" — sends `cancel_tapped`.
 *
 * Safe-area + keyboard avoidance so the skip-note input stays visible
 * with the keyboard up.
 */
export function HandoffSheet({
  visible,
  instructions,
  suggestedPath,
  onOpenPreview,
  onSkip,
  onCancel,
}: HandoffSheetProps) {
  const t = useTheme();
  const [showSkipNote, setShowSkipNote] = useState(false);
  const [note, setNote] = useState('');

  const closeAndReset = () => {
    setShowSkipNote(false);
    setNote('');
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={() => {
        onCancel();
        closeAndReset();
      }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.backdrop, { backgroundColor: t.surface.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface.raised }]}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
          <Text style={[styles.title, { color: t.text.primary }]}>
            Claude needs your help
          </Text>
          <ScrollView style={styles.bodyWrap}>
            <Text style={[styles.body, { color: t.text.primary }]}>{instructions}</Text>
          </ScrollView>
          {suggestedPath ? (
            <Text style={[styles.subtle, { color: t.text.secondary }]}>
              Will open: {suggestedPath}
            </Text>
          ) : null}

          {showSkipNote ? (
            <View style={styles.noteBlock}>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Optional note for Claude (e.g. why you're skipping)"
                placeholderTextColor={t.text.placeholder}
                maxLength={HANDOFF_NOTE_MAX_LEN}
                style={[
                  styles.noteInput,
                  {
                    color: t.text.primary,
                    backgroundColor: t.surface.base,
                    borderColor: t.border.subtle,
                  },
                ]}
                multiline
              />
              <View style={styles.row}>
                <Pressable
                  onPress={() => {
                    setShowSkipNote(false);
                    setNote('');
                  }}
                  style={({ pressed }) => [
                    styles.btnSecondary,
                    { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
                  ]}>
                  <Text style={[styles.btnLabel, { color: t.text.secondary }]}>Back</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    onSkip(note.trim() ? { note: note.trim() } : undefined);
                    closeAndReset();
                  }}
                  style={({ pressed }) => [
                    styles.btnPrimary,
                    { backgroundColor: pressed ? t.accent.pressed : t.accent.primary },
                  ]}>
                  <Text style={[styles.btnLabel, { color: t.accent.fg }]}>Send skip</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              <Pressable
                onPress={onOpenPreview}
                style={({ pressed }) => [
                  styles.btnPrimary,
                  { backgroundColor: pressed ? t.accent.pressed : t.accent.primary },
                ]}>
                <Text style={[styles.btnLabel, { color: t.accent.fg }]}>Open Preview</Text>
              </Pressable>
              <View style={styles.row}>
                <Pressable
                  onPress={() => setShowSkipNote(true)}
                  style={({ pressed }) => [
                    styles.btnSecondary,
                    { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
                  ]}>
                  <Text style={[styles.btnLabel, { color: t.text.secondary }]}>Skip…</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    onCancel();
                    closeAndReset();
                  }}
                  style={({ pressed }) => [
                    styles.btnSecondary,
                    { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
                  ]}>
                  <Text style={[styles.btnLabel, { color: t.status.danger }]}>Cancel</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: space[5],
    paddingTop: space[2],
    paddingBottom: space[8] + 4,
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
  title: { fontSize: fontSize['2xl'], fontWeight: '700' },
  bodyWrap: { maxHeight: 220 },
  body: { fontSize: fontSize.base, lineHeight: 22 },
  subtle: { fontSize: fontSize.sm },
  btnPrimary: {
    paddingVertical: space[3] + 2,
    borderRadius: radius.xl,
    alignItems: 'center',
    flex: 1,
  },
  btnSecondary: {
    paddingVertical: space[3],
    paddingHorizontal: space[3],
    borderRadius: radius.xl,
    alignItems: 'center',
    flex: 1,
  },
  btnLabel: { fontSize: fontSize.lg, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space[2] },
  noteBlock: { gap: space[3] },
  noteInput: {
    minHeight: 80,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space[3],
    paddingVertical: space[3],
    fontSize: fontSize.base,
  },
});
