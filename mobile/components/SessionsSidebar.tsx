import { fetchSessions } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import type { SessionListItem } from '@/lib/types';
import { fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

interface SessionsSidebarProps {
  visible: boolean;
  onClose: () => void;
  currentAgent: string;
  currentSessionId: string;
}

function statusDot(s: SessionListItem, t: Theme): string {
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
}: SessionsSidebarProps) {
  const t = useTheme();
  const settings = useHydratedSettings();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slide = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, slide, scrim]);

  useEffect(() => {
    if (!visible || !settings.baseUrl) return;
    let cancelled = false;
    setError(null);
    fetchSessions({ baseUrl: settings.baseUrl, token: settings.token })
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String((err as Error).message ?? err));
          setSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, settings.baseUrl, settings.token]);

  const close = () => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-PANEL_WIDTH, 0],
  });

  const ordered = useMemo(() => {
    const list = sessions ?? [];
    return [...list].sort((a, b) => b.lastModified - a.lastModified);
  }, [sessions]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={close}
      statusBarTranslucent>
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
          {sessions === null && !error ? (
            <View style={styles.centered}>
              <ActivityIndicator />
            </View>
          ) : error ? (
            <View style={styles.centered}>
              <Text style={[styles.errorText, { color: t.text.secondary }]}>{error}</Text>
            </View>
          ) : ordered.length === 0 ? (
            <View style={styles.centered}>
              <Text style={{ color: t.text.secondary }}>No sessions.</Text>
            </View>
          ) : (
            <FlatList
              data={ordered}
              keyExtractor={(s) => `${s.agent}:${s.id}`}
              renderItem={({ item }) => {
                const isCurrent = item.agent === currentAgent && item.id === currentSessionId;
                const title = item.label ?? item.projectName;
                return (
                  <Pressable
                    onPress={() => {
                      if (isCurrent) {
                        close();
                        return;
                      }
                      close();
                      setTimeout(
                        () => router.replace(`/sessions/${item.agent}/${item.id}`),
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
                        style={[
                          styles.title,
                          { color: t.text.primary, fontWeight: isCurrent ? '700' : '600' },
                        ]}>
                        {title}
                      </Text>
                      <Text style={[styles.ago, { color: t.text.muted }]}>
                        {fmtAgo(item.lastModified)}
                      </Text>
                    </View>
                    {item.preview ? (
                      <Text
                        numberOfLines={1}
                        style={[styles.preview, { color: t.text.secondary }]}>
                        {item.preview}
                      </Text>
                    ) : null}
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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[6] },
  errorText: { fontSize: fontSize.sm, textAlign: 'center' },
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
  preview: { fontSize: fontSize.sm, lineHeight: 17 },
});
