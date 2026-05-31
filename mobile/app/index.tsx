import {
  BridgeError,
  fetchSessions,
  renameSession,
  type BridgeErrorKind,
} from '@/lib/bridge';
import { usePermissionDecision } from '@/lib/permissions';
import { useHydratedSettings, usePendingPermissions } from '@/lib/store';
import { summarizeToolInput } from '@/lib/toolSummary';
import type { SessionListItem } from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
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

function pendingKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

/** Strip the scheme so the nav-bar title shows just the tailnet host
 *  (`mymac.tail1234.ts.net`) rather than the full `https://…` URL. */
function prettyHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '');
  }
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

interface ErrorView {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  /** Which primary action to offer. 'settings' for auth/config problems the
   *  user fixes in settings; 'retry' for transient connectivity. */
  action: 'retry' | 'settings';
  /** Show a "Retry" secondary even when the primary is "Open settings". */
  secondaryRetry?: boolean;
}

/** Turn a thrown error into a friendly, actionable error screen. Distinguishes
 *  auth/permission problems (fix in settings) from connectivity (retry). */
function describeError(err: unknown): ErrorView {
  const kind: BridgeErrorKind | undefined = err instanceof BridgeError ? err.kind : undefined;
  switch (kind) {
    case 'auth':
      return {
        icon: 'key-outline',
        title: 'Authentication failed',
        body: "The bridge rejected your token (401). It may be wrong, expired, or missing. Re-scan the QR code from the bridge to refresh it.",
        action: 'settings',
        secondaryRetry: true,
      };
    case 'forbidden':
      return {
        icon: 'lock-closed-outline',
        title: 'Access denied',
        body: "Your Tailscale identity isn't in the bridge's allowed users (403). Add it via ALLOWED_USERS on the bridge, then retry.",
        action: 'settings',
        secondaryRetry: true,
      };
    case 'mixed-content':
      return {
        icon: 'warning-outline',
        title: 'Connection blocked',
        body: (err as Error).message,
        action: 'settings',
        secondaryRetry: true,
      };
    case 'timeout':
      return {
        icon: 'time-outline',
        title: 'Bridge not responding',
        body: "Reached the network but the bridge didn't answer in time. Make sure it's running, then retry.",
        action: 'retry',
        secondaryRetry: false,
      };
    case 'network':
    default:
      return {
        icon: 'cloud-offline-outline',
        title: "Can't reach the bridge",
        body: "Couldn't connect. Check that you're on the same tailnet, the bridge is running, and the URL is correct.",
        action: 'retry',
        secondaryRetry: false,
      };
  }
}

export default function SessionsScreen() {
  const settings = useHydratedSettings();
  const t = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Pending approvals are kept in a global store so the WS survives navigation
  // and we don't miss events fired while the user is inside a chat.
  const pending = usePendingPermissions((s) => s.byKey);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { decide, isBusy } = usePermissionDecision();

  const load = useCallback(async () => {
    if (!settings.baseUrl) return;
    setError(null);
    try {
      const data = await fetchSessions({ baseUrl: settings.baseUrl, token: settings.token });
      setSessions(data);
    } catch (err) {
      setError(err);
      setSessions([]);
    }
  }, [settings.baseUrl, settings.token]);

  useEffect(() => {
    if (settings.hydrated && settings.baseUrl) void load();
  }, [settings.hydrated, settings.baseUrl, load]);

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

  // Connection-status dot for the nav-bar title: loading → muted,
  // failed fetch → danger, otherwise we're talking to the bridge.
  const connDot =
    sessions === null ? t.text.muted : error ? t.status.danger : t.sessionStatus.desktop;

  return (
    <>
      <Stack.Screen
        options={{
          headerTitleAlign: 'left',
          headerTitle: () => (
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={10}
              style={styles.titleButton}>
              <View style={[styles.titleDot, { backgroundColor: connDot }]} />
              <Text numberOfLines={1} style={[styles.titleHost, { color: t.text.primary }]}>
                {prettyHost(settings.baseUrl)}
              </Text>
              <Ionicons name="chevron-down" size={fontSize.sm} color={t.text.muted} />
            </Pressable>
          ),
        }}
      />
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
          totalPending > 0 ? (
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
          ) : null
        }
      ListEmptyComponent={
        sessions === null ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : error ? (
          (() => {
            const view = describeError(error);
            return (
              <View style={styles.centered}>
                <View style={[styles.errorIcon, { backgroundColor: t.surface.raised }]}>
                  <Ionicons name={view.icon} size={30} color={t.text.secondary} />
                </View>
                <Text style={[styles.errorTitle, { color: t.text.primary }]}>{view.title}</Text>
                <Text style={[styles.errorBody, { color: t.text.secondary }]}>{view.body}</Text>
                {view.action === 'settings' ? (
                  <>
                    <Pressable
                      onPress={() => router.push('/settings')}
                      style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
                      <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Open settings</Text>
                    </Pressable>
                    {view.secondaryRetry ? (
                      <Pressable onPress={load} hitSlop={8} style={styles.secondaryButton}>
                        <Text style={[styles.secondaryButtonLabel, { color: t.accent.primary }]}>Retry</Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : (
                  <Pressable onPress={load} style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
                    <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Retry</Text>
                  </Pressable>
                )}
              </View>
            );
          })()
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
                  const rowBusy = isBusy(p);
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
                          disabled={rowBusy}
                          onPress={() => decide(p, 'allow')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.accent.pressed : t.accent.primary,
                              opacity: rowBusy ? 0.5 : 1,
                            },
                          ]}>
                          <Text style={[styles.pendingButtonLabel, { color: t.accent.fg }]}>Allow</Text>
                        </Pressable>
                        <Pressable
                          disabled={rowBusy}
                          onPress={() => decide(p, 'allow_always')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: t.border.default,
                              opacity: rowBusy ? 0.5 : 1,
                            },
                          ]}>
                          <Text style={[styles.pendingButtonLabel, { color: t.text.primary }]}>
                            Always
                          </Text>
                        </Pressable>
                        <Pressable
                          disabled={rowBusy}
                          onPress={() => decide(p, 'deny')}
                          style={({ pressed }) => [
                            styles.pendingButton,
                            {
                              backgroundColor: pressed ? t.status.dangerCardBg : 'transparent',
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: t.status.danger,
                              opacity: rowBusy ? 0.5 : 1,
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
    </>
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
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: space[2], maxWidth: 280 },
  titleDot: { width: 8, height: 8, borderRadius: 4 },
  titleHost: { fontSize: fontSize.lg, fontWeight: '600', flexShrink: 1 },
  banner: {
    marginHorizontal: space[3],
    marginTop: space[2],
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
  errorIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space[1],
  },
  errorTitle: { fontSize: fontSize['2xl'], fontWeight: '600', textAlign: 'center' },
  errorBody: { fontSize: fontSize.base, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  secondaryButton: { paddingVertical: space[2], paddingHorizontal: space[4] },
  secondaryButtonLabel: { fontSize: fontSize.base, fontWeight: '600' },
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
