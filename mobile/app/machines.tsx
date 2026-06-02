import { useAggregator, type BridgeConnState } from '@/lib/aggregator';
import { bridgeColor, useHydratedBridges, type Bridge } from '@/lib/bridges';
import { discoverBridges } from '@/lib/discovery';
import { fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stateLabel(state: BridgeConnState | undefined, sessions: number, lastSeenMs: number | undefined, t: Theme) {
  switch (state) {
    case 'open':
      return { text: `online · ${sessions} session${sessions === 1 ? '' : 's'}`, color: t.sessionStatus.desktop };
    case 'connecting':
      return { text: 'connecting…', color: t.text.muted };
    case 'unauthorised':
      return { text: 're-auth needed', color: t.status.danger };
    case 'offline':
      return {
        text: lastSeenMs ? `offline · seen ${fmtAgo(lastSeenMs)}` : 'offline',
        color: t.status.warning,
      };
    default:
      return { text: lastSeenMs ? `last seen ${fmtAgo(lastSeenMs)}` : 'not checked', color: t.text.muted };
  }
}

export default function MachinesScreen() {
  const t = useTheme();
  const { bridges, addBridge, updateBridge, removeBridge } = useHydratedBridges();
  const connState = useAggregator((s) => s.connState);
  const byBridge = useAggregator((s) => s.byBridge);
  const refresh = useAggregator((s) => s.refresh);
  const refreshBridge = useAggregator((s) => s.refreshBridge);
  const forget = useAggregator((s) => s.forget);
  const [refreshing, setRefreshing] = useState(false);

  // Pull-to-refresh does double duty: refresh reachability AND run anchor
  // discovery. New machines prompt "Add all"; finding nothing new is silent
  // (no nagging alert on every pull).
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
      const anchor = bridges.find((b) => connState[b.id] === 'open') ?? bridges[0];
      if (anchor) {
        const found = await discoverBridges(anchor, bridges);
        if (found.length > 0) {
          Alert.alert(
            `Found ${found.length} machine${found.length === 1 ? '' : 's'}`,
            found.map((b) => `• ${b.name}`).join('\n'),
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Add all',
                onPress: async () => {
                  for (const b of found) await addBridge(b);
                  void refresh();
                },
              },
            ],
          );
        }
      }
    } catch {
      // Pull-to-refresh stays quiet on failure (offline / not on the serve path).
    } finally {
      setRefreshing(false);
    }
  };

  const onRename = (b: Bridge) => {
    Alert.prompt(
      'Rename machine',
      'A friendly label for this machine.',
      async (text?: string) => {
        const next = (text ?? '').trim();
        if (next) await updateBridge(b.id, { name: next });
      },
      'plain-text',
      b.name,
    );
  };

  const onRemove = (b: Bridge) => {
    Alert.alert(
      'Remove machine',
      `Remove "${b.name}"? Its sessions disappear from the app — the bridge itself is untouched, and it can be re-added by discovery.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeBridge(b.id);
            forget(b.id);
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Machines' }} />
      <FlatList
        style={{ backgroundColor: t.surface.base }}
        contentContainerStyle={{ paddingVertical: space[2] }}
        data={bridges}
        keyExtractor={(b) => b.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.text.primary} />
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={{ color: t.text.secondary }}>No machines yet.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const sessions = byBridge[item.id]?.length ?? 0;
          const st = connState[item.id];
          const s = stateLabel(st, sessions, item.lastSeenMs, t);
          return (
            <View style={[styles.row, { borderBottomColor: t.border.subtle }]}>
              <View style={[styles.dot, { backgroundColor: bridgeColor(item) }]} />
              <Pressable style={{ flex: 1 }} onPress={() => void refreshBridge(item.id)}>
                <Text numberOfLines={1} style={[styles.name, { color: t.text.primary }]}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={[styles.host, { color: t.text.muted }]}>
                  {item.baseUrl.replace(/^https?:\/\//, '')}
                  {item.authMode === 'bearer' ? ' · token' : ''}
                </Text>
                <Text style={[styles.state, { color: s.color }]}>
                  {s.text}
                  {st && st !== 'open' ? ' · tap to retry' : ''}
                </Text>
              </Pressable>
              <Pressable onPress={() => onRename(item)} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="pencil" size={fontSize.lg} color={t.text.secondary} />
              </Pressable>
              <Pressable onPress={() => onRemove(item)} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="trash-outline" size={fontSize.lg} color={t.status.danger} />
              </Pressable>
            </View>
          );
        }}
        ListFooterComponent={
          <View style={styles.footer}>
            <Pressable
              onPress={() => router.push('/settings')}
              style={[styles.actionButton, { backgroundColor: t.surface.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border.default }]}>
              <Text style={[styles.actionLabel, { color: t.text.primary }]}>Add manually (QR / URL)</Text>
            </Pressable>
            <Text style={[styles.footerHint, { color: t.text.muted }]}>
              Pull down to refresh and find new machines on your tailnet.
            </Text>
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center', padding: space[8] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  name: { fontSize: fontSize.lg, fontWeight: '600' },
  host: { fontSize: fontSize.sm, marginTop: 1 },
  state: { fontSize: fontSize.sm, marginTop: 2, fontWeight: '500' },
  iconButton: { padding: space[2] },
  footer: { padding: space[4], gap: space[3] },
  actionButton: { paddingVertical: space[3], borderRadius: radius.lg, alignItems: 'center' },
  actionLabel: { fontSize: fontSize.base, fontWeight: '600' },
  footerHint: { fontSize: fontSize.sm, textAlign: 'center' },
});
