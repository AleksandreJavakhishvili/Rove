import { useRef, type ReactNode } from 'react';
import {
  Animated,
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
 *  • Plays a subtle press-in scale animation (~0.97) on touch-down and
 *    springs back on release, giving haptic-adjacent visual feedback
 *    that the menu is about to open.
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
      speed: 30,
      bounciness: 6,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => animateTo(0.97)}
      onPressOut={() => animateTo(1)}
      delayLongPress={delayLongPress}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
