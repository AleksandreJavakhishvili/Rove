import { useHydratedBadgePosition, type BadgeSide } from '@/lib/store';
import { fontSize, radius, space, useTheme } from '@/theme';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ApprovalBadgeProps {
  count: number;
  onPress: () => void;
}

const EDGE_MARGIN = space[3];
/** Reserve room at the bottom so the badge never floats over the composer. */
const BOTTOM_KEEPOUT = 96;
/** Movement (px) before a gesture counts as a drag rather than a tap. */
const DRAG_THRESHOLD = 8;

/**
 * Floating "N waiting" badge that opens the cross-session approval tray. It is
 * draggable and snaps to the nearer left/right edge on release; the dropped
 * `{ side, y }` is persisted (via the store) so it returns to where the user
 * left it, even though the badge unmounts whenever no requests are pending.
 *
 * `y` is clamped into the safe band (below header, above composer) at layout
 * time, so a value stored on a taller screen degrades gracefully.
 */
export function ApprovalBadge({ count, onPress }: ApprovalBadgeProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const pos = useHydratedBadgePosition();

  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [badge, setBadge] = useState({ w: 0, h: 0 });
  const placed = useRef(false);

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const appear = useSharedValue(0);

  const ready = container.w > 0 && badge.w > 0 && pos.hydrated;

  function restingX(side: BadgeSide): number {
    return side === 'left' ? EDGE_MARGIN : container.w - badge.w - EDGE_MARGIN;
  }
  function minY(): number {
    return insets.top + EDGE_MARGIN;
  }
  function maxY(): number {
    return Math.max(minY(), container.h - badge.h - BOTTOM_KEEPOUT - insets.bottom);
  }
  function clampY(y: number): number {
    return Math.min(Math.max(y, minY()), maxY());
  }

  // Seed the resting position once sizes + persisted prefs are known. A stored
  // y of 0 (never dragged) defaults to the bottom of the safe band. Runs in an
  // effect (not render) so writing shared values is legal and the fade-in
  // worklet stays reactive.
  useEffect(() => {
    if (!ready || placed.current) return;
    placed.current = true;
    tx.value = restingX(pos.side);
    ty.value = pos.y > 0 ? clampY(pos.y) : maxY();
    appear.value = withTiming(1, { duration: 160 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, container.w, container.h, badge.w, badge.h, pos.side, pos.y]);

  function persist(side: BadgeSide, y: number) {
    void pos.setPosition(side, y);
  }

  const pan = Gesture.Pan()
    .activeOffsetX([-DRAG_THRESHOLD, DRAG_THRESHOLD])
    .activeOffsetY([-DRAG_THRESHOLD, DRAG_THRESHOLD])
    .onStart(() => {
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e) => {
      tx.value = startX.value + e.translationX;
      ty.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      const center = tx.value + badge.w / 2;
      const side: BadgeSide = center < container.w / 2 ? 'left' : 'right';
      const snappedX = restingX(side);
      const clampedY = clampY(ty.value);
      tx.value = withSpring(snappedX, { damping: 18, stiffness: 200 });
      ty.value = withSpring(clampedY, { damping: 18, stiffness: 200 });
      runOnJS(persist)(side, clampedY);
    });

  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(onPress)();
  });

  // Race: a quick tap fires onPress; movement past the threshold engages the
  // pan instead. Because the badge owns this gesture, dragging it never starts
  // the chat pager's back-swipe (R1).
  const gesture = Gesture.Race(pan, tap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    opacity: appear.value,
  }));

  function onContainerLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    setContainer({ w: width, h: height });
  }
  function onBadgeLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== badge.w || height !== badge.h) setBadge({ w: width, h: height });
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={onContainerLayout}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          onLayout={onBadgeLayout}
          style={[styles.badge, { backgroundColor: t.accent.primary }, animatedStyle]}
          accessibilityRole="button"
          accessibilityLabel={`${count} session${count === 1 ? '' : 's'} waiting for approval. Opens approval tray.`}>
          <View style={[styles.dot, { backgroundColor: t.accent.fg }]} />
          <Text style={[styles.label, { color: t.accent.fg }]}>{count} waiting</Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: fontSize.md, fontWeight: '700' },
});
