import { fontFamily, fontSize, radius, space, useTheme } from '@/theme';
import { SECRET_PATH_MAX_LEN } from '@/lib/types';
import { useEffect, useState } from 'react';
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

interface SecretSheetProps {
  /** Env-var name the agent requested, e.g. `OPENAI_API_KEY`. */
  name: string;
  /** Plain-language reason the agent supplied. */
  reason: string;
  /** Resolved default destination (cwd-relative); the user may edit it. */
  path: string;
  /** User pasted a value and tapped Provide. `value` is the raw secret;
   *  `path` is the (possibly edited) destination. */
  onProvide: (value: string, path: string) => void;
  /** User declined. */
  onDeny: () => void;
}

/**
 * Secure entry sheet for the Rove Secrets SDD (`set_secret`). This is the
 * ONLY surface a credential should be typed into — deliberately separate
 * from the chat composer. The value is held in local component state,
 * sent on a side channel (`secret_provide`), and cleared on unmount; it is
 * never written to a chat draft, a store, or a log. The masked input
 * defaults to hidden with an explicit reveal toggle so the user can verify
 * a paste without exposing it on screen by default.
 *
 * The parent mounts this only while a request is pending (keyed by
 * requestId), so closing the sheet unmounts it and drops the value.
 */
export function SecretSheet({ name, reason, path, onProvide, onDeny }: SecretSheetProps) {
  const t = useTheme();
  const [value, setValue] = useState('');
  const [dest, setDest] = useState(path);
  const [reveal, setReveal] = useState(false);

  // Defense-in-depth: clear the value from state on unmount so it doesn't
  // linger in memory after the sheet closes.
  useEffect(() => {
    return () => setValue('');
  }, []);

  const canProvide = value.trim().length > 0 && dest.trim().length > 0;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onDeny}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.backdrop, { backgroundColor: t.surface.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface.raised }]}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />

          <Text style={[styles.title, { color: t.text.primary }]}>Provide a secret</Text>
          <Text style={[styles.subtitle, { color: t.text.secondary }]}>
            Claude is asking for{' '}
            <Text style={[styles.mono, { color: t.text.primary }]}>{name}</Text>. Paste it here —
            it goes straight to your machine and is never shown to the agent or added to the chat.
          </Text>

          <ScrollView style={styles.bodyWrap} keyboardShouldPersistTaps="handled">
            <Text style={[styles.reason, { color: t.text.secondary }]}>{reason}</Text>
          </ScrollView>

          <View style={styles.fieldRow}>
            <Text style={[styles.label, { color: t.text.secondary }]}>{name}</Text>
            <Pressable hitSlop={8} onPress={() => setReveal((r) => !r)}>
              <Text style={[styles.reveal, { color: t.accent.primary }]}>
                {reveal ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
          </View>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="Paste the secret value"
            placeholderTextColor={t.text.placeholder}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            textContentType="password"
            keyboardType={reveal ? 'visible-password' : 'default'}
            style={[
              styles.input,
              styles.mono,
              { color: t.text.primary, backgroundColor: t.surface.base, borderColor: t.border.subtle },
            ]}
            autoFocus
          />

          <Text style={[styles.label, { color: t.text.secondary }]}>Write to</Text>
          <TextInput
            value={dest}
            onChangeText={setDest}
            placeholder=".env"
            placeholderTextColor={t.text.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            maxLength={SECRET_PATH_MAX_LEN}
            style={[
              styles.input,
              styles.mono,
              { color: t.text.primary, backgroundColor: t.surface.base, borderColor: t.border.subtle },
            ]}
          />
          <Text style={[styles.hint, { color: t.text.muted }]}>
            Written into this file in your project (auto-gitignored). Stays inside the project
            directory.
          </Text>

          <View style={styles.row}>
            <Pressable
              onPress={onDeny}
              style={({ pressed }) => [
                styles.btnSecondary,
                { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
              ]}>
              <Text style={[styles.btnLabel, { color: t.status.danger }]}>Deny</Text>
            </Pressable>
            <Pressable
              disabled={!canProvide}
              onPress={() => onProvide(value.trim(), dest.trim())}
              style={({ pressed }) => [
                styles.btnPrimary,
                {
                  backgroundColor: canProvide
                    ? pressed
                      ? t.accent.pressed
                      : t.accent.primary
                    : t.surface.pressed,
                },
              ]}>
              <Text
                style={[
                  styles.btnLabel,
                  { color: canProvide ? t.accent.fg : t.text.muted },
                ]}>
                Provide
              </Text>
            </Pressable>
          </View>
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
  subtitle: { fontSize: fontSize.base, lineHeight: 20 },
  bodyWrap: { maxHeight: 120 },
  reason: { fontSize: fontSize.base, lineHeight: 20 },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: fontSize.sm, fontWeight: '600' },
  reveal: { fontSize: fontSize.sm, fontWeight: '600' },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space[3],
    paddingVertical: space[3],
    fontSize: fontSize.base,
  },
  mono: { fontFamily: fontFamily.mono },
  hint: { fontSize: fontSize.xs, lineHeight: 16 },
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
  row: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
});
