import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { INDICATOR_FADE_MS } from './constants';

interface Props {
  visible: boolean;
  /** Headline label, e.g. "Verifying" / "Done". */
  label: string;
  /** Optional sub-label rendered next to the headline (the in-flight
   *  path or `"current view"` when omitted). */
  detail?: string;
  /** Wired to the Cancel button. Hidden when `null`. */
  onCancel: (() => void) | null;
}

/**
 * Floating pill rendered above the chat / workspace pager whenever the
 * preview is under agent direction. Uses a safe-area top inset so it
 * sits below the navigation header on devices with a notch. Animates
 * in/out via opacity (no layout shift) so the chat list underneath
 * doesn't reflow.
 *
 * Pure presentation — state machine lives in `useTakeover`.
 */
export function TakeoverIndicator({ visible, label, detail, onCancel }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: INDICATOR_FADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  // Soft 1.0 → 0.4 → 1.0 pulse on the leading dot whenever visible.
  useEffect(() => {
    if (!visible) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  const dotOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.4],
  });

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        styles.wrap,
        {
          top: insets.top + space[2],
          opacity,
        },
      ]}>
      <View
        style={[
          styles.pill,
          {
            backgroundColor: t.surface.raised,
            borderColor: t.accent.primary,
            shadowColor: '#000',
          },
        ]}>
        <Animated.View
          style={[styles.dot, { backgroundColor: t.accent.primary, opacity: dotOpacity }]}
        />
        <Text style={[styles.label, { color: t.text.primary }]} numberOfLines={1}>
          {label}
          {detail ? (
            <Text style={[styles.detail, { color: t.text.secondary }]}>
              {' '}
              · {detail}
            </Text>
          ) : null}
        </Text>
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={10}
            style={({ pressed }) => [
              styles.cancel,
              { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
            ]}>
            <Ionicons name="close" size={fontSize.base} color={t.text.secondary} />
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3] + 2,
    paddingVertical: space[2] - 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    maxWidth: '90%',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: { fontSize: fontSize.sm, fontWeight: '600' },
  detail: { fontWeight: '400' },
  cancel: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: space[1],
  },
});
