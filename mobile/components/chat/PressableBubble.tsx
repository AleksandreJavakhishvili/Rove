import { useRef, type ReactNode } from 'react';
import {
  Animated,
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

// Animatable Pressable so the press-scale transform and the bubble's
// layout styles (alignSelf, maxWidth, padding, background) live on the
// same element. Splitting them across two views broke the maxWidth: 85%
// resolution — the inner element's percent reference was the unsized
// outer Pressable, collapsing the bubble to a single column of letters.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PressableBubbleProps {
  onLongPress: (event: GestureResponderEvent) => void;
  /** Visual styling of the bubble (background, padding, radius, alignSelf). */
  style: StyleProp<ViewStyle>;
  children: ReactNode;
  /** Optional tap handler — links inside the markdown still consume their
   *  own taps, so this fires only for taps on padding / non-link text. */
  onPress?: () => void;
  delayLongPress?: number;
}

/**
 * Bubble container that:
 *  • Makes the whole bubble (text *and* padding) a long-press target,
 *    so the user doesn't need to land precisely on a text glyph.
 *  • Plays a subtle press-in scale animation (~0.985, no bounce) on
 *    touch-down and eases back on release, giving haptic-adjacent visual
 *    feedback that the menu is about to open.
 *
 * Markdown links inside the bubble continue to receive their own taps
 * because the inner Text components have higher-specificity press
 * handlers; the bubble's `onLongPress` only fires when the user holds
 * past `delayLongPress`.
 */
export function PressableBubble({
  onLongPress,
  onPress,
  style,
  children,
  delayLongPress = 320,
}: PressableBubbleProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 24,
      bounciness: 0,
    }).start();
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => animateTo(0.985)}
      onPressOut={() => animateTo(1)}
      delayLongPress={delayLongPress}
      style={[style, { transform: [{ scale }] }]}>
      {children}
    </AnimatedPressable>
  );
}
