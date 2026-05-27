import type { UploadResult } from '@/lib/uploads';
import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

interface ScreenshotComposerProps {
  /** Open/close. Parent owns the state. */
  visible: boolean;
  /** The just-captured upload — used for the thumbnail (via localUri data
   *  URL) and as the attachment to send. Null while the parent is still
   *  capturing/uploading; we render a spinner in that case. */
  upload: UploadResult | null;
  /** Called when the user taps Send. Receives the optional note + the
   *  upload reference so the parent can post the multimodal user turn. */
  onSend: (args: { note: string; upload: UploadResult }) => void | Promise<void>;
  /** Called when the user dismisses without sending. */
  onCancel: () => void;
}

/**
 * Bottom-sheet composer for the manual screenshot capture flow.
 *
 * Visual flow:
 *  1. User taps shutter → sheet slides up with a spinner (we're still
 *     uploading the PNG to the bridge).
 *  2. Upload resolves → spinner replaced by thumbnail + caption input.
 *  3. User adds optional note + taps Send → parent posts a normal user
 *     turn with the screenshot attached.
 *  4. Send / Cancel both close the sheet; parent owns dismiss + pager
 *     swap.
 *
 * The sheet uses a Modal + Animated.View for the slide-up to keep the
 * mount cost zero when closed.
 */
export function ScreenshotComposer({
  visible,
  upload,
  onSend,
  onCancel,
}: ScreenshotComposerProps) {
  const t = useTheme();
  const slide = useRef(new Animated.Value(0)).current;
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (visible) {
      setNote('');
      setSending(false);
      Animated.timing(slide, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      slide.setValue(0);
    }
  }, [visible, slide]);

  const handleSend = async () => {
    if (!upload || sending) return;
    setSending(true);
    try {
      await onSend({ note: note.trim(), upload });
    } finally {
      setSending(false);
    }
  };

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [400, 0],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent>
      {/* `KeyboardAvoidingView` lifts the sheet via flex layout (the
          sheet anchors to bottom via `justifyContent: flex-end`).
          With `position: absolute` + `bottom: 0` (the old layout)
          padding had nothing to push because the sheet was outside
          the flex flow. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.fill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel}>
          <View style={styles.scrim} />
        </Pressable>
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: t.surface.base,
              borderTopColor: t.border.subtle,
              transform: [{ translateY }],
            },
          ]}>
          <View style={[styles.handle, { backgroundColor: t.border.default }]} />
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: t.text.primary }]}>Send screenshot</Text>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Ionicons name="close" size={fontSize['2xl']} color={t.text.secondary} />
            </Pressable>
          </View>

          {upload?.localUri ? (
            <View
              style={[
                styles.thumbnailWrap,
                { backgroundColor: t.surface.sunken, borderColor: t.border.subtle },
              ]}>
              <Image source={{ uri: upload.localUri }} style={styles.thumbnail} resizeMode="contain" />
            </View>
          ) : (
            <View
              style={[
                styles.thumbnailWrap,
                styles.thumbnailLoading,
                { backgroundColor: t.surface.sunken, borderColor: t.border.subtle },
              ]}>
              <ActivityIndicator color={t.text.secondary} />
              <Text style={[styles.uploadingLabel, { color: t.text.secondary }]}>
                Uploading screenshot…
              </Text>
            </View>
          )}

          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Add a note (optional)…"
            placeholderTextColor={t.text.placeholder}
            multiline
            style={[
              styles.input,
              {
                color: t.text.primary,
                backgroundColor: t.surface.raised,
                borderColor: t.border.subtle,
              },
            ]}
          />

          <View style={styles.buttonRow}>
            <Pressable
              onPress={onCancel}
              disabled={sending}
              style={({ pressed }) => [
                styles.button,
                {
                  backgroundColor: pressed ? t.surface.pressed : 'transparent',
                  borderColor: t.border.default,
                  opacity: sending ? 0.4 : 1,
                },
              ]}>
              <Text style={[styles.buttonLabel, { color: t.text.secondary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSend}
              disabled={!upload || sending}
              style={({ pressed }) => [
                styles.button,
                styles.primaryButton,
                {
                  backgroundColor: !upload
                    ? t.surface.pressed
                    : pressed
                      ? t.accent.pressed
                      : t.accent.primary,
                  opacity: sending ? 0.7 : 1,
                },
              ]}>
              {sending ? (
                <ActivityIndicator color={t.accent.fg} />
              ) : (
                <Text style={[styles.buttonLabel, { color: t.accent.fg, fontWeight: '700' }]}>
                  Send
                </Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Anchors the sheet to the bottom of the available area so
  // KeyboardAvoidingView's padding can push it up when the keyboard
  // opens. Don't switch the sheet itself to position:absolute — that
  // takes it out of the flex flow and KAV becomes a no-op.
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    paddingHorizontal: space[4],
    paddingTop: space[2],
    paddingBottom: space[8],
    borderTopLeftRadius: radius['2xl'],
    borderTopRightRadius: radius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[3],
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    marginBottom: space[2],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: fontSize.xl, fontWeight: '700' },
  thumbnailWrap: {
    width: '100%',
    height: 180,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  thumbnail: { width: '100%', height: '100%' },
  thumbnailLoading: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
  },
  uploadingLabel: { fontSize: fontSize.sm },
  input: {
    fontSize: fontSize.base,
    minHeight: 72,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: 'top',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space[2],
  },
  button: {
    flex: 1,
    paddingVertical: space[3],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    borderColor: 'transparent',
  },
  buttonLabel: { fontSize: fontSize.base, fontWeight: '600' },
});
