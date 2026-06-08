import type { PendingRequestSnapshot } from '@/lib/bridge';
import { fontSize, radius, space, useTheme } from '@/theme';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ownerLabel } from './labels';

interface RequestWhisperProps {
  /** The most recent background request to announce, or null to dismiss. */
  request: PendingRequestSnapshot | null;
  onPress: () => void;
  onDismiss: () => void;
}

/** How long the whisper stays before parking into the badge. */
const AUTO_DISMISS_MS = 4000;

/**
 * Transient, top-anchored heads-up that a *background* session is now waiting.
 * Awareness only — no Allow/Deny here (acting from a one-line banner would risk
 * approving blind); tapping opens the tray where full context lives. Auto-parks
 * into the badge after a few seconds. The single-banner invariant is enforced
 * by the controller: it only ever passes the newest request, so a fresh arrival
 * swaps the content and resets the timer rather than stacking banners.
 */
export function RequestWhisper({ request, onPress, onDismiss }: RequestWhisperProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);

  const id = request?.toolUseId ?? null;

  useEffect(() => {
    if (!id) {
      progress.value = withTiming(0, { duration: 160 });
      return;
    }
    // Slide in + light haptic on each new arrival; the timer restarts because
    // this effect is keyed on the request id.
    progress.value = withTiming(1, { duration: 180 });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const handle = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -24 }],
  }));

  if (!request) return null;

  return (
    <View
      style={[styles.wrap, { top: insets.top + space[2] }]}
      pointerEvents="box-none">
      <Animated.View style={animatedStyle} pointerEvents="auto">
        <Pressable
          onPress={onPress}
          style={[styles.banner, { backgroundColor: t.surface.raised, borderColor: t.border.default }]}
          accessibilityRole="button"
          accessibilityLabel={`${ownerLabel(request)} wants to run ${request.tool}. Opens approval tray.`}>
          <View style={[styles.dot, { backgroundColor: t.accent.primary }]} />
          <Text style={[styles.text, { color: t.text.primary }]} numberOfLines={1}>
            <Text style={{ color: t.text.secondary }}>{ownerLabel(request)}</Text>
            {'  wants '}
            <Text style={{ fontWeight: '700' }}>{request.tool}</Text>
          </Text>
          <Text style={[styles.chevron, { color: t.text.muted }]}>›</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space[3], right: space[3], alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '100%',
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 1,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { flexShrink: 1, fontSize: fontSize.md },
  chevron: { fontSize: fontSize.lg, fontWeight: '700' },
});
