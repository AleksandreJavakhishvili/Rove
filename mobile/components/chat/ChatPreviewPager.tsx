import { space, useTheme } from '@/theme';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  /**
   * Per-page badge flags. When `true`, the matching dot pulses + uses
   * the accent color to signal "there's something new here." Indexed
   * by page (0 = chat, 1 = workspace). Used by the chat screen to
   * surface a "files changed" hint on the workspace dot without
   * cluttering the header. Pages whose badge is `false` (or absent)
   * render the normal dot.
   */
  pageBadges?: boolean[];
}

/** Imperative handle exposed via ref. Used by the screenshot composer to
 *  auto-swap back to the chat after the user hits Send so they see the
 *  response come in without an extra swipe. The takeover controller
 *  uses `setLocked` to suppress pan input during agent capture so the
 *  user can't accidentally swipe out from under the WebView. */
export interface ChatPreviewPagerHandle {
  setIndex: (index: number) => void;
  setLocked: (locked: boolean) => void;
  /** Current pager index. Used by the takeover controller to snapshot
   *  the user's prior position before forcing a swap to Preview. */
  getIndex: () => number;
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
export const ChatPreviewPager = forwardRef<ChatPreviewPagerHandle, Props>(function ChatPreviewPager(
  { chat, workspace, onIndexChange, pageBadges },
  ref,
) {
  const { width } = useWindowDimensions();
  const t = useTheme();
  const translateX = useSharedValue(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [locked, setLocked] = useState(false);
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;

  useImperativeHandle(ref, () => ({
    setIndex: (index: number) => {
      const clamped = Math.max(0, Math.min(pages.length - 1, index));
      setActiveIndex(clamped);
      translateX.value = withTiming(-clamped * width, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
    },
    setLocked: (next: boolean) => setLocked(next),
    getIndex: () => activeIndexRef.current,
  }));

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
    .enabled(!keyboardVisible && !locked)
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
        {pages.map((p, i) => {
          const badged = Boolean(pageBadges?.[i]);
          // Inactive page with a badge → use accent color so the user
          // notices "there's something new there." Active page always
          // wins (the user is looking at it, no need to pulse).
          const color =
            activeIndex === i
              ? t.text.primary
              : badged
                ? t.accent.primary
                : t.text.muted;
          const opacity = activeIndex === i ? 1 : badged ? 1 : 0.4;
          return (
            <View
              key={p.key}
              style={[
                styles.dot,
                badged && activeIndex !== i ? styles.dotBadged : null,
                { backgroundColor: color, opacity },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
});

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
  // Slightly larger than a normal dot so an inactive badged dot
  // reads as "this has something new" without being shouty.
  dotBadged: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
