import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { INDICATOR_FADE_MS } from '../takeover/constants';

interface Props {
  visible: boolean;
  /** Agent's prose, rendered as a one-liner (numberOfLines=1). */
  instructions: string;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * Top pill that replaces the `<HandoffSheet>` once the user taps "Open
 * Preview." The user is now in the WebView doing setup work; the pill
 * reminds them what they're doing and gives them Done / Cancel.
 */
export function HandoffPill({ visible, instructions, onDone, onCancel }: Props) {
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

  useEffect(() => {
    if (!visible) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
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
        { top: insets.top + space[2], opacity },
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
        <Text
          style={[styles.label, { color: t.text.primary }]}
          numberOfLines={1}>
          {instructions}
        </Text>
        <View style={styles.actions}>
          <Pressable
            onPress={onCancel}
            hitSlop={6}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
            ]}>
            <Ionicons name="close" size={fontSize.base} color={t.status.danger} />
          </Pressable>
          <Pressable
            onPress={onDone}
            style={({ pressed }) => [
              styles.doneBtn,
              { backgroundColor: pressed ? t.accent.pressed : t.accent.primary },
            ]}>
            <Text style={[styles.doneLabel, { color: t.accent.fg }]}>Done</Text>
          </Pressable>
        </View>
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
    zIndex: 21,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingLeft: space[3],
    paddingRight: space[1],
    paddingVertical: space[1] + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    maxWidth: '92%',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '500',
    maxWidth: 200,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  actionBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtn: {
    paddingHorizontal: space[3],
    paddingVertical: space[1] + 2,
    borderRadius: radius.pill,
  },
  doneLabel: { fontSize: fontSize.sm, fontWeight: '700' },
});
