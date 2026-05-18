import { fetchSessions, renameSession } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import type { SessionListItem } from '@/lib/types';
import { fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Link, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

function statusBadge(s: SessionListItem, t: Theme) {
  switch (s.status) {
    case 'live-bridge':
      return { dot: t.sessionStatus.bridge, label: 'live · phone' };
    case 'live-desktop':
      return { dot: t.sessionStatus.desktop, label: 'live · desktop' };
    default:
      return { dot: t.sessionStatus.idle, label: 'idle' };
  }
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function SessionsScreen() {
  const settings = useHydratedSettings();
  const t = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!settings.baseUrl) return;
    setError(null);
    try {
      const data = await fetchSessions({ baseUrl: settings.baseUrl, token: settings.token });
      setSessions(data);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setSessions([]);
    }
  }, [settings.baseUrl, settings.token]);

  useEffect(() => {
    if (settings.hydrated && settings.baseUrl) void load();
  }, [settings.hydrated, settings.baseUrl, load]);

  if (!settings.hydrated) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!settings.baseUrl) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <Text style={[styles.welcomeTitle, { color: t.text.primary }]}>Connect to your bridge</Text>
        <Text style={[styles.welcomeBody, { color: t.text.secondary }]}>
          Point this app at the bridge running on your desktop over Tailscale.
        </Text>
        <Link href="/settings" asChild>
          <Pressable style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
            <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Open settings</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: t.surface.base }}
      contentContainerStyle={{ paddingVertical: 4 }}
      data={sessions ?? []}
      keyExtractor={(s) => `${s.agent}:${s.id}`}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={t.text.primary}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={[styles.headerHost, { color: t.text.secondary }]}>{settings.baseUrl}</Text>
          <Pressable onPress={() => router.push('/settings')}>
            <Text style={[styles.headerEdit, { color: t.accent.primary }]}>Edit</Text>
          </Pressable>
        </View>
      }
      ListEmptyComponent={
        sessions === null ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={[styles.errorTitle, { color: t.text.primary }]}>Couldn&apos;t load sessions</Text>
            <Text style={[styles.errorBody, { color: t.text.secondary }]}>{error}</Text>
            <Pressable onPress={load} style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
              <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.centered}>
            <Text style={{ color: t.text.secondary }}>No sessions yet.</Text>
          </View>
        )
      }
      renderItem={({ item }) => {
        const badge = statusBadge(item, t);
        const title = item.label ?? item.projectName;
        const subtitle = item.label ? item.projectName : null;
        const onRename = () => {
          Alert.prompt(
            'Rename session',
            'Give this session a name. Leave blank to clear.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Save',
                onPress: async (text?: string) => {
                  const next = (text ?? '').trim();
                  try {
                    await renameSession(
                      { baseUrl: settings.baseUrl, token: settings.token },
                      item.agent,
                      item.id,
                      next === '' ? null : next,
                    );
                    void load();
                  } catch (err) {
                    Alert.alert('Rename failed', String((err as Error).message ?? err));
                  }
                },
              },
            ],
            'plain-text',
            item.label ?? '',
          );
        };
        return (
          <Pressable
            onPress={() => router.push(`/sessions/${item.agent}/${item.id}`)}
            onLongPress={onRename}
            delayLongPress={350}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? t.surface.raised : 'transparent',
                borderBottomColor: t.border.subtle,
              },
            ]}>
            <View style={styles.rowHeader}>
              <View style={[styles.dot, { backgroundColor: badge.dot }]} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.projectName, { color: t.text.primary }]}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text numberOfLines={1} style={[styles.subtitle, { color: t.text.muted }]}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.timestamp, { color: t.text.muted }]}>{fmtAgo(item.lastModified)}</Text>
            </View>
            <Text numberOfLines={2} style={[styles.preview, { color: t.text.secondary }]}>
              {item.preview || '(no first message yet)'}
            </Text>
            <View style={styles.rowFooter}>
              <Text style={[styles.statusLabel, { color: t.text.secondary }]}>{badge.label}</Text>
              <Text style={[styles.agentLabel, { color: t.text.muted }]}>{item.agent}</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[6], gap: space[3] },
  welcomeTitle: { fontSize: fontSize['4xl'], fontWeight: '700' },
  welcomeBody: { fontSize: fontSize.lg, textAlign: 'center', maxWidth: 320, lineHeight: 22 },
  primaryButton: {
    marginTop: space[3],
    paddingHorizontal: space[6],
    paddingVertical: space[3],
    borderRadius: radius.lg + 2,
  },
  primaryButtonLabel: { fontSize: fontSize.xl, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingVertical: space[2] + 2,
  },
  headerHost: { fontSize: fontSize.sm, flex: 1 },
  headerEdit: { fontSize: fontSize.md, fontWeight: '500' },
  row: { paddingHorizontal: space[4], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  projectName: { fontSize: fontSize.xl, fontWeight: '600' },
  subtitle: { fontSize: fontSize.sm, marginTop: 1 },
  timestamp: { fontSize: fontSize.sm },
  preview: { fontSize: fontSize.md, lineHeight: 20 },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  statusLabel: { fontSize: fontSize.sm },
  agentLabel: { fontSize: fontSize.sm },
  errorTitle: { fontSize: fontSize['2xl'], fontWeight: '600' },
  errorBody: { fontSize: fontSize.base, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
});
