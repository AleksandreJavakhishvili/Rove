import { bridgeColor, shortBridgeName, useBridges } from '@/lib/bridges';
import { useAggregator, type TaggedSession } from '@/lib/aggregator';
import { fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

interface SessionsSidebarProps {
  visible: boolean;
  onClose: () => void;
  currentAgent: string;
  currentSessionId: string;
  /** The bridge the current chat lives on; the switcher opens scoped to it. */
  currentBridgeId: string;
}

function statusDot(s: TaggedSession, t: Theme): string {
  switch (s.status) {
    case 'live-bridge':
      return t.sessionStatus.bridge;
    case 'live-desktop':
      return t.sessionStatus.desktop;
    default:
      return t.sessionStatus.idle;
  }
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

const PANEL_WIDTH = Math.min(320, Math.round(Dimensions.get('window').width * 0.84));

export function SessionsSidebar({
  visible,
  onClose,
  currentAgent,
  currentSessionId,
  currentBridgeId,
}: SessionsSidebarProps) {
  const t = useTheme();
  const bridges = useBridges();
  const byBridge = useAggregator((s) => s.byBridge);
  const refresh = useAggregator((s) => s.refresh);
  const slide = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  // null = "All machines"; otherwise scope to one. Opens on the current machine.
  const [scope, setScope] = useState<string | null>(currentBridgeId);

  useEffect(() => {
    if (!visible) return;
    setScope(currentBridgeId);
    void refresh();
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrim, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [visible, currentBridgeId, refresh, slide, scrim]);

  const close = () => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrim, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [-PANEL_WIDTH, 0] });

  const bridgeById = useMemo(() => new Map(bridges.map((b) => [b.id, b])), [bridges]);

  // Machines that have sessions, current one first, for the scope chips.
  const machines = useMemo(() => {
    const withSessions = bridges.filter((b) => (byBridge[b.id]?.length ?? 0) > 0);
    return withSessions.sort((a, b) =>
      a.id === currentBridgeId ? -1 : b.id === currentBridgeId ? 1 : 0,
    );
  }, [bridges, byBridge, currentBridgeId]);

  const rows = useMemo(() => {
    const list = scope ? (byBridge[scope] ?? []) : Object.values(byBridge).flat();
    return [...list].sort((a, b) => b.lastModified - a.lastModified);
  }, [byBridge, scope]);

  const showChips = machines.length > 1;

  const renderChip = (id: string | null, label: string, color?: string) => {
    const selected = scope === id;
    return (
      <Pressable
        key={id ?? 'all'}
        onPress={() => setScope(id)}
        style={[
          styles.chip,
          {
            backgroundColor: selected ? t.accent.primary : t.surface.raised,
            borderColor: selected ? t.accent.primary : t.border.subtle,
          },
        ]}>
        {color ? <View style={[styles.chipDot, { backgroundColor: color }]} /> : null}
        <Text
          numberOfLines={1}
          style={[styles.chipLabel, { color: selected ? t.accent.fg : t.text.secondary }]}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: '#000', opacity: scrim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }) },
          ]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>
        <Animated.View
          style={[
            styles.panel,
            {
              width: PANEL_WIDTH,
              backgroundColor: t.surface.base,
              borderRightColor: t.border.subtle,
              transform: [{ translateX }],
            },
          ]}>
          <View style={[styles.header, { borderBottomColor: t.border.subtle }]}>
            <Text style={[styles.headerTitle, { color: t.text.primary }]}>Sessions</Text>
            <Pressable
              onPress={() => {
                close();
                setTimeout(() => router.replace('/'), 180);
              }}
              hitSlop={8}>
              <Ionicons name="expand-outline" size={fontSize['2xl']} color={t.accent.primary} />
            </Pressable>
          </View>
          {showChips ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipStrip}>
              {machines.map((b) => renderChip(b.id, shortBridgeName(b), bridgeColor(b)))}
              {renderChip(null, 'All')}
            </ScrollView>
          ) : null}
          {rows.length === 0 ? (
            <View style={styles.centered}>
              <Text style={{ color: t.text.secondary }}>No sessions.</Text>
            </View>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(s) => `${s.bridgeId}:${s.agent}:${s.id}`}
              renderItem={({ item }) => {
                const isCurrent =
                  item.agent === currentAgent &&
                  item.id === currentSessionId &&
                  item.bridgeId === currentBridgeId;
                const title = item.label ?? item.projectName;
                const bridge = bridgeById.get(item.bridgeId);
                return (
                  <Pressable
                    onPress={() => {
                      if (isCurrent) {
                        close();
                        return;
                      }
                      close();
                      setTimeout(
                        () => router.replace(`/sessions/${item.agent}/${item.id}?bridge=${item.bridgeId}`),
                        180,
                      );
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      {
                        backgroundColor: isCurrent
                          ? t.surface.raised
                          : pressed
                            ? t.surface.sunken
                            : 'transparent',
                        borderBottomColor: t.border.subtle,
                        borderLeftColor: isCurrent ? t.accent.primary : 'transparent',
                      },
                    ]}>
                    <View style={styles.rowHeader}>
                      <View style={[styles.dot, { backgroundColor: statusDot(item, t) }]} />
                      <Text
                        numberOfLines={1}
                        style={[styles.title, { color: t.text.primary, fontWeight: isCurrent ? '700' : '600' }]}>
                        {title}
                      </Text>
                      <Text style={[styles.ago, { color: t.text.muted }]}>{fmtAgo(item.lastModified)}</Text>
                    </View>
                    <View style={styles.rowMeta}>
                      {bridge ? (
                        <>
                          <View style={[styles.machineDot, { backgroundColor: bridgeColor(bridge) }]} />
                          <Text style={[styles.machineName, { color: t.text.muted }]} numberOfLines={1}>
                            {shortBridgeName(bridge)}
                          </Text>
                        </>
                      ) : null}
                      {item.preview ? (
                        <Text numberOfLines={1} style={[styles.preview, { color: t.text.secondary }]}>
                          {bridge ? '· ' : ''}
                          {item.preview}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              }}
            />
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingTop: space[12],
    paddingBottom: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: fontSize.xl, fontWeight: '700' },
  chipStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    height: 32,
    gap: space[1],
    paddingHorizontal: space[3],
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 180,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipLabel: { fontSize: fontSize.sm, fontWeight: '600', flexShrink: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[6] },
  row: {
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    gap: 4,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { flex: 1, fontSize: fontSize.md },
  ago: { fontSize: fontSize.xs },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  machineDot: { width: 7, height: 7, borderRadius: 3.5 },
  machineName: { fontSize: fontSize.xs, fontWeight: '600', maxWidth: 90 },
  preview: { fontSize: fontSize.sm, lineHeight: 17, flexShrink: 1 },
});
