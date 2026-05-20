import {
  fetchPendingPermissions,
  fetchSessions,
  openEventsStream,
  renameSession,
  sendApproval,
  type PendingPermissionSnapshot,
} from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import type { SessionListItem } from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { router } from 'expo-router';
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

type PendingMap = Record<string, PendingPermissionSnapshot[]>;

function pendingKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

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

/**
 * Produce a tight one-line description of a tool invocation for the inline
 * approval card. Optimized for the tools Claude actually prompts on — Bash and
 * the file-mutation set are the long tail; everything else falls back to a
 * compact JSON peek.
 */
function summarizeToolInput(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'Bash' && typeof o.command === 'string') return o.command;
  if (
    (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') &&
    typeof o.file_path === 'string'
  ) {
    return o.file_path;
  }
  if (tool === 'WebFetch' && typeof o.url === 'string') return o.url;
  if (tool === 'WebSearch' && typeof o.query === 'string') return o.query;
  try {
    const j = JSON.stringify(o);
    return j.length > 120 ? j.slice(0, 117) + '…' : j;
  } catch {
    return '';
  }
}

export default function SessionsScreen() {
  const settings = useHydratedSettings();
  const t = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<PendingMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

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

  // Hydrate pending approvals + subscribe to the bridge-wide event stream so we
  // can badge rows the moment a session asks for permission, without having to
  // open a per-session WS for every visible row.
  useEffect(() => {
    if (!settings.hydrated || !settings.baseUrl) return;
    let cancelled = false;
    fetchPendingPermissions({ baseUrl: settings.baseUrl, token: settings.token })
      .then((list) => {
        if (cancelled) return;
        const next: PendingMap = {};
        for (const p of list) {
          const k = pendingKey(p.agent, p.sessionId);
          (next[k] ??= []).push(p);
        }
        setPending(next);
      })
      .catch((err) => console.warn('[sessions] pending hydrate failed', err));
    const stream = openEventsStream(
      { baseUrl: settings.baseUrl, token: settings.token },
      (msg) => {
        if (msg.type === 'permissions_snapshot') {
          const next: PendingMap = {};
          for (const p of msg.pending) {
            const k = pendingKey(p.agent, p.sessionId);
            (next[k] ??= []).push(p);
          }
          setPending(next);
        } else if (msg.type === 'permission_added') {
          const k = pendingKey(msg.pending.agent, msg.pending.sessionId);
          setPending((prev) => ({
            ...prev,
            [k]: [...(prev[k] ?? []), msg.pending],
          }));
        } else if (msg.type === 'permission_resolved') {
          const k = pendingKey(msg.agent, msg.sessionId);
          setPending((prev) => {
            const list = (prev[k] ?? []).filter((p) => p.toolUseId !== msg.toolUseId);
            const copy = { ...prev };
            if (list.length === 0) delete copy[k];
            else copy[k] = list;
            return copy;
          });
        }
      },
    );
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [settings.hydrated, settings.baseUrl, settings.token]);

  const decide = useCallback(
    async (
      p: PendingPermissionSnapshot,
      decision: 'allow' | 'allow_always' | 'deny',
    ) => {
      const key = `${p.agent}:${p.sessionId}:${p.toolUseId}`;
      setBusy((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await sendApproval(
          { baseUrl: settings.baseUrl, token: settings.token },
          p.agent,
          p.sessionId,
          p.toolUseId,
          decision,
        );
        // The bridge will broadcast permission_resolved which clears the entry;
        // no need to optimistically drop it here.
      } catch (err) {
        Alert.alert('Approval failed', String((err as Error).message ?? err));
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [settings.baseUrl, settings.token],
  );

  const totalPending = Object.values(pending).reduce((n, list) => n + list.length, 0);
  const sessionsWithPending = Object.keys(pending).length;

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
        <Pressable
          onPress={() => router.push('/settings')}
          style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
          <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Open settings</Text>
        </Pressable>
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
        <View>
          <View style={styles.header}>
            <Text style={[styles.headerHost, { color: t.text.secondary }]}>{settings.baseUrl}</Text>
            <Pressable onPress={() => router.push('/settings')}>
              <Text style={[styles.headerEdit, { color: t.accent.primary }]}>Edit</Text>
            </Pressable>
          </View>
          {totalPending > 0 ? (
            <View
              style={[
                styles.banner,
                {
                  backgroundColor: t.status.warningCardBg,
                  borderColor: t.status.warning,
                },
              ]}>
              <Text style={[styles.bannerLabel, { color: t.status.warningCardFg }]}>
                {totalPending} approval{totalPending === 1 ? '' : 's'} pending
                {sessionsWithPending > 1 ? ` · ${sessionsWithPending} sessions` : ''}
              </Text>
              <Text style={[styles.bannerHint, { color: t.status.warningCardFg }]}>
                Tap a highlighted session to act on it.
              </Text>
            </View>
          ) : null}
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
        const k = pendingKey(item.agent, item.id);
        const itemsPending = pending[k] ?? [];
        const isExpanded = expanded.has(k);
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
          <View
            style={[
              styles.rowContainer,
              itemsPending.length > 0
                ? { borderLeftColor: t.status.warning, borderLeftWidth: 3 }
                : null,
            ]}>
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
                <View style={styles.rowFooterRight}>
                  {itemsPending.length > 0 ? (
                    <Pressable
                      onPress={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(k)) next.delete(k);
                          else next.add(k);
                          return next;
                        })
                      }
                      hitSlop={6}
                      style={[
                        styles.pendingChip,
                        { backgroundColor: t.status.warning, borderColor: t.status.warning },
                      ]}>
                      <Text style={[styles.pendingChipLabel, { color: t.text.inverse }]}>
                        {itemsPending.length} approval{itemsPending.length === 1 ? '' : 's'} {isExpanded ? '▴' : '▾'}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Text style={[styles.agentLabel, { color: t.text.muted }]}>{item.agent}</Text>
                </View>
              </View>
            </Pressable>
            {isExpanded && itemsPending.length > 0 ? (
              <View
                style={[
                  styles.pendingPanel,
                  { backgroundColor: t.surface.sunken, borderBottomColor: t.border.subtle },
                ]}>
                {itemsPending.map((p) => {
                  const summary = summarizeToolInput(p.tool, p.input);
                  const busyKey = `${p.agent}:${p.sessionId}:${p.toolUseId}`;
                  const isBusy = busy.has(busyKey);
                  return (
                    <View
                      key={p.toolUseId}
                      style={[
                        styles.pendingCard,
                        { backgroundColor: t.surface.raised, borderColor: t.border.subtle },
                      ]}>
                      <Text style={[styles.pendingTool, { color: t.text.primary }]}>{p.tool}</Text>
                      {summary ? (
                        <Text
                          style={[styles.pendingSummary, { color: t.text.secondary }]}
                          numberOfLines={3}>
                          {summary}
                        </Text>
                      ) : null}
                      <View style={styles.pendingActions}>
                        <Pressable
                          disabled={isBusy}
                          onPress={() => decide(p, 'allow')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.accent.pressed : t.accent.primary,
                              opacity: isBusy ? 0.5 : 1,
                            },
                          ]}>
                          <Text style={[styles.pendingButtonLabel, { color: t.accent.fg }]}>Allow</Text>
                        </Pressable>
                        <Pressable
                          disabled={isBusy}
                          onPress={() => decide(p, 'allow_always')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: t.border.default,
                              opacity: isBusy ? 0.5 : 1,
                            },
                          ]}>
                          <Text style={[styles.pendingButtonLabel, { color: t.text.primary }]}>
                            Always
                          </Text>
                        </Pressable>
                        <Pressable
                          disabled={isBusy}
                          onPress={() => decide(p, 'deny')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.status.dangerCardBg : 'transparent',
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: t.status.danger,
                              opacity: isBusy ? 0.5 : 1,
                            },
                          ]}>
                          <Text style={[styles.pendingButtonLabel, { color: t.status.danger }]}>Deny</Text>
                        </Pressable>
                      </View>
                      <Pressable
                        onPress={() => router.push(`/sessions/${p.agent}/${p.sessionId}`)}
                        hitSlop={6}>
                        <Text style={[styles.openChat, { color: t.accent.primary }]}>Open chat for context →</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
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
  banner: {
    marginHorizontal: space[3],
    marginBottom: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  bannerLabel: { fontSize: fontSize.base, fontWeight: '700' },
  bannerHint: { fontSize: fontSize.sm },
  rowContainer: {},
  row: { paddingHorizontal: space[4], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  projectName: { fontSize: fontSize.xl, fontWeight: '600' },
  subtitle: { fontSize: fontSize.sm, marginTop: 1 },
  timestamp: { fontSize: fontSize.sm },
  preview: { fontSize: fontSize.md, lineHeight: 20 },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  rowFooterRight: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  pendingChip: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pendingChipLabel: { fontSize: fontSize.xs, fontWeight: '700' },
  statusLabel: { fontSize: fontSize.sm },
  agentLabel: { fontSize: fontSize.sm },
  errorTitle: { fontSize: fontSize['2xl'], fontWeight: '600' },
  errorBody: { fontSize: fontSize.base, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
  pendingPanel: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space[2],
  },
  pendingCard: {
    padding: space[3],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[2],
  },
  pendingTool: { fontSize: fontSize.md, fontWeight: '700' },
  pendingSummary: { fontSize: fontSize.sm, fontFamily: fontFamily.mono, lineHeight: 18 },
  pendingActions: { flexDirection: 'row', gap: space[2] },
  pendingButton: {
    flex: 1,
    paddingVertical: space[2],
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  pendingButtonLabel: { fontSize: fontSize.base, fontWeight: '600' },
  openChat: { fontSize: fontSize.sm, fontWeight: '500', alignSelf: 'flex-start' },
});
