import type { PendingPermissionSnapshot } from '@/lib/bridge';
import { usePermissionDecision } from '@/lib/permissions';
import { dangerLevel, summarizeToolInput } from '@/lib/toolSummary';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { router } from 'expo-router';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeOut,
  LinearTransition,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ownerLabel } from './labels';

interface ApprovalTrayProps {
  open: boolean;
  requests: PendingPermissionSnapshot[];
  onClose: () => void;
}

/** Fraction of row width a swipe must cross to fire. Deny is intentionally
 *  harder to reach than Allow, and disabled entirely for high-risk rows so a
 *  destructive command is never denied — or allowed — by a careless flick. */
const ALLOW_FRACTION = 0.32;
const DENY_FRACTION = 0.55;
const SWIPE_ACTIVATE = 14;

function dangerColor(level: ReturnType<typeof dangerLevel>, t: Theme): string {
  return level === 'high' ? t.status.danger : level === 'medium' ? t.status.warning : t.accent.primary;
}

/**
 * Horizontal swipe-to-decide wrapper. Swipe right past the allow threshold to
 * Allow; swipe left past the (larger) deny threshold to Deny. Both gestures are
 * disabled on high-risk rows and while a decision is in flight; the buttons
 * inside always remain as the accessible, unambiguous path.
 */
function SwipeableRow({
  enabled,
  allowSwipe,
  denySwipe,
  onAllow,
  onDeny,
  t,
  children,
}: {
  enabled: boolean;
  allowSwipe: boolean;
  denySwipe: boolean;
  onAllow: () => void;
  onDeny: () => void;
  t: Theme;
  children: React.ReactNode;
}) {
  const tx = useSharedValue(0);
  const width = useSharedValue(0);

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-SWIPE_ACTIVATE, SWIPE_ACTIVATE])
    .failOffsetY([-16, 16])
    .onUpdate((e) => {
      // Resist dragging in a disabled direction so it reads as "not allowed".
      if ((e.translationX > 0 && !allowSwipe) || (e.translationX < 0 && !denySwipe)) {
        tx.value = e.translationX * 0.15;
      } else {
        tx.value = e.translationX;
      }
    })
    .onEnd(() => {
      const w = width.value || 1;
      if (allowSwipe && tx.value > w * ALLOW_FRACTION) {
        tx.value = withTiming(w, { duration: 160 });
        runOnJS(onAllow)();
      } else if (denySwipe && tx.value < -w * DENY_FRACTION) {
        tx.value = withTiming(-w, { duration: 160 });
        runOnJS(onDeny)();
      } else {
        tx.value = withSpring(0, { damping: 18, stiffness: 220 });
      }
    });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const allowHint = useAnimatedStyle(() => ({
    opacity: width.value ? Math.min(Math.max(tx.value / (width.value * ALLOW_FRACTION), 0), 1) : 0,
  }));
  const denyHint = useAnimatedStyle(() => ({
    opacity: width.value ? Math.min(Math.max(-tx.value / (width.value * DENY_FRACTION), 0), 1) : 0,
  }));

  function onLayout(e: LayoutChangeEvent) {
    width.value = e.nativeEvent.layout.width;
  }

  return (
    <View onLayout={onLayout}>
      <View style={styles.hintLayer} pointerEvents="none">
        <Animated.Text style={[styles.hint, { color: t.accent.primary }, allowHint]}>Allow</Animated.Text>
        <Animated.Text style={[styles.hint, { color: t.status.danger }, denyHint]}>Deny</Animated.Text>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={cardStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

function Row({
  p,
  busy,
  onDecide,
  onOpen,
}: {
  p: PendingPermissionSnapshot;
  busy: boolean;
  onDecide: (decision: 'allow' | 'allow_always' | 'deny') => void;
  onOpen: () => void;
}) {
  const t = useTheme();
  const summary = summarizeToolInput(p.tool, p.input);
  const level = dangerLevel(p.tool, p.input);
  const accent = dangerColor(level, t);
  const owner = ownerLabel(p);
  const highRisk = level === 'high';

  return (
    <Animated.View layout={LinearTransition} exiting={FadeOut.duration(180)}>
      <SwipeableRow
        enabled={!busy}
        allowSwipe={!highRisk}
        denySwipe={!highRisk}
        onAllow={() => onDecide('allow')}
        onDeny={() => onDecide('deny')}
        t={t}>
        <View style={[styles.row, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
          <View style={styles.rowHead}>
            <View style={[styles.dangerDot, { backgroundColor: accent }]} />
            <Text style={[styles.owner, { color: t.text.secondary }]} numberOfLines={1}>
              {owner}
            </Text>
            <Text style={[styles.tool, { color: accent }]}>{p.tool}</Text>
          </View>
          {summary ? (
            <Text style={[styles.summary, { color: t.text.primary }]} numberOfLines={3}>
              {summary}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              disabled={busy}
              onPress={() => onDecide('allow')}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: pressed ? t.accent.pressed : t.accent.primary, opacity: busy ? 0.5 : 1 },
              ]}>
              <Text style={[styles.btnLabel, { color: t.accent.fg }]}>Allow</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() => onDecide('allow_always')}
              style={({ pressed }) => [
                styles.btn,
                {
                  backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.border.default,
                  opacity: busy ? 0.5 : 1,
                },
              ]}>
              <Text style={[styles.btnLabel, { color: t.text.primary }]}>Always</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() => onDecide('deny')}
              style={({ pressed }) => [
                styles.btn,
                {
                  backgroundColor: pressed ? t.status.dangerCardBg : 'transparent',
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.status.danger,
                  opacity: busy ? 0.5 : 1,
                },
              ]}>
              <Text style={[styles.btnLabel, { color: t.status.danger }]}>Deny</Text>
            </Pressable>
          </View>
          <Pressable onPress={onOpen} hitSlop={6}>
            <Text style={[styles.open, { color: t.accent.primary }]}>Open session for context →</Text>
          </Pressable>
        </View>
      </SwipeableRow>
    </Animated.View>
  );
}

/**
 * Bottom-sheet listing every *other* session's pending permission request.
 * Overlays the chat without unmounting it, so dismissing returns the user to
 * their exact scroll position and draft. Each row identifies the owning
 * session/repo, tool, input summary, and risk so the user never approves blind.
 */
export function ApprovalTray({ open, requests, onClose }: ApprovalTrayProps) {
  const t = useTheme();
  const { decide, isBusy } = usePermissionDecision();

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      {/* A Modal renders in its own native view tree, OUTSIDE the app-root
          GestureHandlerRootView. The swipe-to-decide rows below use
          GestureDetector, which throws unless it's under a root view — so the
          tray hosts its own. Without this, opening the tray crashes the app. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable style={[styles.backdrop, { backgroundColor: t.surface.scrim }]} onPress={onClose}>
          {/* Inner Pressable swallows taps so pressing a row doesn't dismiss. */}
          <Pressable style={[styles.sheet, { backgroundColor: t.surface.base }]} onPress={() => {}}>
            <ErrorBoundary label="ApprovalTray">
              <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
              <Text style={[styles.title, { color: t.text.primary }]}>
                {requests.length > 0 ? `Waiting on you · ${requests.length}` : 'All caught up'}
              </Text>
              {requests.length === 0 ? (
                <Text style={[styles.empty, { color: t.text.secondary }]}>
                  No other sessions are waiting for approval.
                </Text>
              ) : (
                <ScrollView style={styles.list} contentContainerStyle={{ gap: space[3] }}>
                  {requests.map((p) => (
                    <Row
                      key={p.toolUseId}
                      p={p}
                      busy={isBusy(p)}
                      onDecide={(d) => decide(p, d)}
                      onOpen={() => {
                        onClose();
                        router.push(`/sessions/${p.agent}/${p.sessionId}`);
                      }}
                    />
                  ))}
                </ScrollView>
              )}
            </ErrorBoundary>
          </Pressable>
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: space[4],
    paddingBottom: space[8] + 4,
    paddingTop: space[2],
    maxHeight: '80%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10, opacity: 0.4 },
  title: { fontSize: fontSize['2xl'], fontWeight: '700', marginBottom: space[3] },
  empty: { fontSize: fontSize.md, paddingBottom: space[6] },
  list: { flexGrow: 0 },
  hintLayer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
  },
  hint: { fontSize: fontSize.md, fontWeight: '700' },
  row: { borderWidth: 1, borderRadius: radius.lg + 2, padding: space[3], gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dangerDot: { width: 8, height: 8, borderRadius: 4 },
  owner: { flex: 1, fontSize: fontSize.sm },
  tool: { fontSize: fontSize.sm, fontWeight: '700' },
  summary: { fontFamily: fontFamily.mono, fontSize: fontSize.base, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space[2], marginTop: 2 },
  btn: { flex: 1, paddingVertical: space[2] + 2, borderRadius: radius.lg, alignItems: 'center' },
  btnLabel: { fontSize: fontSize.md, fontWeight: '600' },
  open: { fontSize: fontSize.sm, fontWeight: '500', marginTop: 2 },
});
