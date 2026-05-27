import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';

interface PreviewShutterProps {
  /** Fires after the press animation + haptic; the parent is responsible
   *  for invoking the actual `captureRef` and opening the composer. */
  onCapture: () => void | Promise<void>;
  /** Optional disabled state — e.g. while a previous capture is still
   *  uploading. Renders the button dimmer and ignores presses. */
  disabled?: boolean;
}

/**
 * Floating shutter button rendered as an overlay inside the Preview
 * mode of WorkspacePane. Placement, sizing, and haptics are tuned to
 * iOS native camera affordances so the gesture reads as "take a
 * picture" rather than "open a settings panel."
 *
 * Visuals:
 *  - 56pt circle, bottom-right, ~space[4] inset from corners
 *  - drop shadow, accent border ring (camera-shutter affordance)
 *  - press-in shrinks ~0.92, springs back
 *  - 90 ms white flash overlay on the parent fills via the sibling
 *    <ShutterFlash/> component (exported alongside)
 *
 * The component owns its own press animation; the flash is a separate
 * sibling so it can size to the WebView, not the button.
 */
export function PreviewShutter({ onCapture, disabled }: PreviewShutterProps) {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const [busy, setBusy] = useState(false);

  const animateTo = (value: number) =>
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: 28,
      bounciness: 6,
    }).start();

  const handlePress = async () => {
    if (busy || disabled) return;
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    }
    setBusy(true);
    try {
      await onCapture();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPressIn={() => animateTo(0.92)}
      onPressOut={() => animateTo(1)}
      onPress={handlePress}
      disabled={disabled || busy}
      hitSlop={10}
      style={styles.touchArea}>
      <Animated.View
        style={[
          styles.button,
          {
            backgroundColor: t.surface.raised,
            borderColor: t.accent.primary,
            opacity: disabled || busy ? 0.6 : 1,
            transform: [{ scale }],
            shadowColor: '#000',
          },
        ]}>
        <View style={[styles.innerDot, { backgroundColor: t.accent.primary }]} />
        <Ionicons
          name="camera"
          size={fontSize.lg}
          color={t.surface.raised}
          style={styles.cameraGlyph}
        />
      </Animated.View>
    </Pressable>
  );
}

/**
 * Brief white flash overlaid on the WebView when a capture fires.
 * Mounted as a sibling absolute-fill view so it sizes to the
 * preview area, not the shutter. Driven by an external `nonce` so
 * each successful capture triggers a new flash without prop-drill.
 */
export function ShutterFlash({ nonce }: { nonce: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const lastNonce = useRef(0);

  if (nonce !== lastNonce.current) {
    lastNonce.current = nonce;
    opacity.setValue(0.75);
    Animated.timing(opacity, {
      toValue: 0,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity }]}
    />
  );
}

const styles = StyleSheet.create({
  touchArea: {
    position: 'absolute',
    right: space[4],
    bottom: space[6],
    zIndex: 10,
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  innerDot: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  cameraGlyph: {
    position: 'absolute',
  },
  // unused but exported for parity with composer styling
  ringHint: {
    fontSize: fontSize.xs,
    paddingTop: 2,
    borderRadius: radius.pill,
  },
});
