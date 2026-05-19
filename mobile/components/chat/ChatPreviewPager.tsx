import { space, useTheme } from '@/theme';
import { useEffect, useState, type ReactNode } from 'react';
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
  /** Left page (chat). */
  chat: ReactNode;
  /** Right page receives a flag so it can pause work when offscreen. */
  preview: (active: boolean) => ReactNode;
  /** Notified when the visible page changes (0 = chat, 1 = preview). */
  onIndexChange?: (index: number) => void;
}

/**
 * Two-page horizontal pager: chat on the left, dev-server preview on the right.
 * Both pages stay mounted so the WebView's loaded page survives swipes.
 *
 * Gesture coexists with the iOS back-swipe: `activeOffsetX` ignores the
 * leading hesitation so the system back gesture wins at the screen edge,
 * and a horizontal threshold prevents the FlatList's vertical scroll from
 * being hijacked.
 */
export function ChatPreviewPager({ chat, preview, onIndexChange }: Props) {
  const { width } = useWindowDimensions();
  const t = useTheme();
  const translateX = useSharedValue(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

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

  const pan = Gesture.Pan()
    .enabled(!keyboardVisible)
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    .onChange((e) => {
      'worklet';
      const next = translateX.value + e.changeX;
      translateX.value = Math.max(-width, Math.min(0, next));
    })
    .onEnd((e) => {
      'worklet';
      const projected = translateX.value + e.velocityX * 0.25;
      const targetIndex = projected < -width / 2 ? 1 : 0;
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
            { flexDirection: 'row', width: width * 2, flex: 1 },
            animatedStyle,
          ]}>
          <View style={{ width, flex: 1 }}>{chat}</View>
          <View style={{ width, flex: 1 }}>{preview(activeIndex === 1)}</View>
        </Animated.View>
      </GestureDetector>
      <View pointerEvents="none" style={styles.dotsRow}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: activeIndex === 0 ? t.text.primary : t.text.muted,
              opacity: activeIndex === 0 ? 1 : 0.4,
            },
          ]}
        />
        <View
          style={[
            styles.dot,
            {
              backgroundColor: activeIndex === 1 ? t.text.primary : t.text.muted,
              opacity: activeIndex === 1 ? 1 : 0.4,
            },
          ]}
        />
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
