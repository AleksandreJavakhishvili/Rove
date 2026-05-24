import { space, useTheme } from '@/theme';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Keyboard, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

interface Props {
  /** Leftmost page (chat). Always present. */
  chat: ReactNode;
  /** Rightmost page — the combined Files/Preview workspace. The renderer
   *  receives a boolean indicating whether it's the currently visible
   *  page so it can defer expensive work when offscreen. */
  workspace: (active: boolean) => ReactNode;
  /** Notified when the visible page changes (0 = chat, 1 = workspace). */
  onIndexChange?: (index: number) => void;
}

/**
 * Two-page horizontal pager: Chat on the left, the combined workspace
 * (Files + Preview behind a segmented header) on the right. Both pages
 * stay mounted so the WebView's loaded URL and the chat list's scroll
 * position survive swipes in either direction.
 *
 * Gesture coexists with the iOS back-swipe: on the leftmost page we only
 * accept left swipes (chat → workspace), letting the system back gesture
 * win at the screen edge. On the rightmost page we only accept right
 * swipes.
 */
export function ChatPreviewPager({ chat, workspace, onIndexChange }: Props) {
  const { width } = useWindowDimensions();
  const t = useTheme();
  const translateX = useSharedValue(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const pages = useMemo(
    () => [
      { key: 'chat', render: () => chat },
      { key: 'workspace', render: workspace },
    ],
    [chat, workspace],
  );

  const pageCount = pages.length;

  // If the page count changes (e.g. files becomes hidden because all the
  // capabilities + session-changes drop away), clamp the active index so
  // we don't end up pointing past the end of the pager.
  useEffect(() => {
    if (activeIndex >= pageCount) {
      setActiveIndex(pageCount - 1);
      translateX.value = withTiming(-(pageCount - 1) * width, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
    }
  }, [pageCount, activeIndex, translateX, width]);

  useEffect(() => {
    onIndexChange?.(activeIndex);
  }, [activeIndex, onIndexChange]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const setIndex = (i: number) => setActiveIndex(i);

  // Allowed pan direction depends on which page is visible:
  //   index 0           → only LEFT swipe (next page); RIGHT must go to
  //                       the iOS back-edge gesture instead.
  //   index pageCount-1 → only RIGHT swipe (previous page).
  //   middle pages      → both directions.
  // RNGH doesn't accept Infinity; use a huge bound to effectively disable
  // the unwanted direction.
  const HUGE = 100_000;
  const activeOffsetX: [number, number] = (() => {
    if (activeIndex === 0) return [-14, HUGE];
    if (activeIndex === pageCount - 1) return [-HUGE, 14];
    return [-14, 14];
  })();

  const pan = Gesture.Pan()
    .enabled(!keyboardVisible)
    .activeOffsetX(activeOffsetX)
    .failOffsetY([-12, 12])
    .onChange((e) => {
      'worklet';
      const next = translateX.value + e.changeX;
      // Clamp the drag inside the valid range for this many pages.
      const minX = -(pageCount - 1) * width;
      translateX.value = Math.max(minX, Math.min(0, next));
    })
    .onEnd((e) => {
      'worklet';
      const projected = translateX.value + e.velocityX * 0.25;
      // Snap to the nearest page boundary, biased by fling velocity.
      // Each page occupies one screen width.
      const rawIndex = -projected / width;
      const targetIndex = Math.max(0, Math.min(pageCount - 1, Math.round(rawIndex)));
      translateX.value = withTiming(-targetIndex * width, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      runOnJS(setIndex)(targetIndex);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            { flexDirection: 'row', width: width * pageCount, flex: 1 },
            animatedStyle,
          ]}>
          {pages.map((p, i) => (
            <View key={p.key} style={{ width, flex: 1 }}>
              {p.render(activeIndex === i)}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
      <View pointerEvents="none" style={styles.dotsRow}>
        {pages.map((p, i) => (
          <View
            key={p.key}
            style={[
              styles.dot,
              {
                backgroundColor: activeIndex === i ? t.text.primary : t.text.muted,
                opacity: activeIndex === i ? 1 : 0.4,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dotsRow: {
    position: 'absolute',
    bottom: space[2],
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space[2],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
