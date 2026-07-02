import { ClaudeMark } from '@/components/ClaudeMark';
import { renameSession } from '@/lib/bridge';
import {
  bridgeColor,
  bridgeToConfig,
  shortBridgeName,
  useHydratedBridges,
  type Bridge,
} from '@/lib/bridges';
import {
  mergeSessions,
  useAggregator,
  type BridgeConnState,
  type TaggedSession,
} from '@/lib/aggregator';
import { useDiscoveryStore } from '@/lib/discovery';
import { usePermissionDecision } from '@/lib/permissions';
import { pendingKey } from '@/lib/pendingSelectors';
import { usePendingRequests } from '@/lib/store';
import { summarizeToolInput } from '@/lib/toolSummary';
import { useDefaultCollapsed } from '@/hooks/useDefaultCollapsed';
import { useExcludeSubagents, isSubagentSession } from '@/hooks/useExcludeSubagents';
import { useRepoPath, matchesRepoPath } from '@/hooks/useRepoPath';
import { useSessionFilters } from '@/hooks/useSessionFilters';
import { useSessionImport } from '@/hooks/useSessionImport';
import { useViewMode, type ViewMode } from '@/hooks/useViewMode';
import { SessionFilterSheet } from '@/components/SessionFilterSheet';
import { ImportProgressBanner } from '@/components/ImportProgressBanner';
import { sessionDb } from '@/lib/sessionDb';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type ListItem = TaggedSession | { _header: true; label: string; count: number; collapsed: boolean };
const VIEW_MODE_CYCLE: ViewMode[] = ['flat', 'grouped-recency', 'grouped-alpha'];

function statusBadge(s: TaggedSession, t: Theme) {
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

function isOfflineState(s: BridgeConnState | undefined): boolean {
  return s === 'offline' || s === 'unauthorised';
}

/** needs-me priority: pending approval first, then live, then everything else
 *  (idle / recent). Within a rank the caller sorts by recency. */
function needsMeRank(s: TaggedSession, hasPending: boolean): number {
  if (hasPending) return 0;
  if (s.status === 'live-bridge' || s.status === 'live-desktop') return 1;
  return 2;
}

export default function SessionsScreen() {
  const t = useTheme();
  const { bridges, hydrated, addBridge } = useHydratedBridges();

  const byBridge = useAggregator((s) => s.byBridge);
  const connState = useAggregator((s) => s.connState);
  const refreshing = useAggregator((s) => s.refreshing);
  const refresh = useAggregator((s) => s.refresh);
  const refreshBridge = useAggregator((s) => s.refreshBridge);
  const discoveryCandidates = useDiscoveryStore((s) => s.candidates);
  const clearDiscovery = useDiscoveryStore((s) => s.clear);

  // Pending approvals across every bridge (one /events stream per machine,
  // keyed by bridgeId), so needs-me / the chip dots reflect the whole fleet.
  const pending = usePendingRequests((s) => s.byKey);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // null = "All"; otherwise scope to one machine. Sticky across refreshes.
  const [filterBridgeId, setFilterBridgeId] = useState<string | null>(null);
  const [filterSheetVisible, setFilterSheetVisible] = useState(false);
  const { filters, addFilter, removeFilter, clearFilters, applyFilters, load: loadFilters } = useSessionFilters();
  const { decide, isBusy } = usePermissionDecision();
  const runImport = useSessionImport((s) => s.runImport);
  const importStatus = useSessionImport((s) => s.status);
  const { viewMode, setViewMode, load: loadViewMode } = useViewMode();
  const { defaultCollapsed, load: loadDefaultCollapsed } = useDefaultCollapsed();
  const { excludeSubagents, load: loadExcludeSubagents } = useExcludeSubagents();
  const { repoPath, load: loadRepoPath } = useRepoPath();

  const [cachedSessions, setCachedSessions] = useState<TaggedSession[]>([]);
  // Tracks repos that are in the NON-default state. When defaultCollapsed is false,
  // this set holds repos the user has manually closed. When true, repos they've opened.
  const [toggledRepos, setToggledRepos] = useState<Set<string>>(new Set());

  // Clear exceptions whenever the default changes so all repos snap to the new default.
  useEffect(() => { setToggledRepos(new Set()); }, [defaultCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRepo = (label: string) =>
    setToggledRepos((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  // Fan out on first hydrate and whenever the set of bridges changes.
  const bridgeIds = bridges.map((b) => b.id).join(',');
  useEffect(() => {
    if (!hydrated || bridges.length === 0) return;
    // Seed from SQLite immediately so the list is populated before the bridge responds.
    Promise.all(bridges.map((b) => sessionDb.getAllForBridge(b.id)))
      .then((results) => setCachedSessions(results.flat()))
      .catch(() => {});
    void refresh();
    for (const b of bridges) void runImport(b);
  }, [hydrated, bridgeIds, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadFilters(); void loadViewMode(); void loadDefaultCollapsed(); void loadExcludeSubagents(); void loadRepoPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When an import finishes, reload SQLite into cachedSessions (it was seeded once
  // on mount before the import ran) and re-poll the bridge (its cache is warm now).
  useEffect(() => {
    if (importStatus !== 'done') return;
    Promise.all(bridges.map((b) => sessionDb.getAllForBridge(b.id)))
      .then((results) => setCachedSessions(results.flat()))
      .catch(() => {});
    void refresh();
  }, [importStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const bridgeById = useMemo(
    () => new Map<string, Bridge>(bridges.map((b) => [b.id, b])),
    [bridges],
  );

  const allSessions = useMemo(() => {
    const live = mergeSessions(byBridge);
    const liveKey = new Set(live.map((s) => `${s.agent}::${s.id}`));
    const historical = cachedSessions.filter((s) => !liveKey.has(`${s.agent}::${s.id}`));
    return [...live, ...historical];
  }, [byBridge, cachedSessions]);

  const repoFiltered = useMemo(
    () => allSessions.filter((s) => matchesRepoPath(s.cwd, repoPath)),
    [allSessions, repoPath],
  );

  const displaySessions = useMemo(
    () => excludeSubagents ? repoFiltered.filter((s) => !isSubagentSession(s)) : repoFiltered,
    [repoFiltered, excludeSubagents],
  );

  // needs-me ordering (pending ▸ live ▸ recent), recency-tiebroken.
  const sorted = useMemo(() => {
    return [...displaySessions]
      .map((s) => {
        const hasPending = (pending[pendingKey(s.bridgeId, s.agent, s.id)]?.length ?? 0) > 0;
        return { s, rank: needsMeRank(s, hasPending) };
      })
      .sort((a, b) => a.rank - b.rank || b.s.lastModified - a.s.lastModified)
      .map((x) => x.s);
  }, [displaySessions, pending]);

  // Machines that actually have sessions, ordered by most-recent activity.
  const orderedMachines = useMemo(() => {
    const lastSeen = new Map<string, number>();
    for (const s of displaySessions) {
      lastSeen.set(s.bridgeId, Math.max(lastSeen.get(s.bridgeId) ?? 0, s.lastModified));
    }
    return bridges
      .filter((b) => lastSeen.has(b.id))
      .sort((a, b) => (lastSeen.get(b.id) ?? 0) - (lastSeen.get(a.id) ?? 0));
  }, [displaySessions, bridges]);

  const machineHasPending = useCallback(
    (bridgeId: string) =>
      displaySessions.some(
        (s) => s.bridgeId === bridgeId && (pending[pendingKey(s.bridgeId, s.agent, s.id)]?.length ?? 0) > 0,
      ),
    [displaySessions, pending],
  );

  const visible = useMemo(() => {
    const byMachine = filterBridgeId ? sorted.filter((s) => s.bridgeId === filterBridgeId) : sorted;
    return applyFilters(byMachine);
  }, [sorted, filterBridgeId, applyFilters, filters]);

  const cycleViewMode = () => {
    const idx = VIEW_MODE_CYCLE.indexOf(viewMode);
    setViewMode(VIEW_MODE_CYCLE[(idx + 1) % VIEW_MODE_CYCLE.length]);
  };

  const listItems = useMemo((): ListItem[] => {
    if (viewMode === 'flat') return visible;
    const byProject = new Map<string, TaggedSession[]>();
    for (const s of visible) {
      const key = s.projectName;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }
    const projectOrder = [...byProject.keys()].sort((a, b) => {
      if (viewMode === 'grouped-alpha') return a.localeCompare(b);
      const lastA = Math.max(...byProject.get(a)!.map((s) => s.lastModified));
      const lastB = Math.max(...byProject.get(b)!.map((s) => s.lastModified));
      return lastB - lastA;
    });
    const items: ListItem[] = [];
    for (const name of projectOrder) {
      const sessions = byProject.get(name)!;
      const collapsed = defaultCollapsed ? !toggledRepos.has(name) : toggledRepos.has(name);
      items.push({ _header: true, label: name, count: sessions.length, collapsed });
      if (!collapsed) items.push(...sessions);
    }
    return items;
  }, [visible, viewMode, toggledRepos, defaultCollapsed]);

  const totalPending = Object.values(pending).reduce((n, list) => n + list.length, 0);
  const sessionsWithPending = Object.keys(pending).length;
  const anyConnecting = bridges.some((b) => connState[b.id] === 'connecting');
  const allOffline =
    bridges.length > 0 && bridges.every((b) => isOfflineState(connState[b.id]));

  if (!hydrated) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (bridges.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <Text style={[styles.welcomeTitle, { color: t.text.primary }]}>Connect a machine</Text>
        <Text style={[styles.welcomeBody, { color: t.text.secondary }]}>
          Point this app at a bridge on your tailnet. Scan its QR or paste the URL — the rest of
          your machines appear automatically.
        </Text>
        <Pressable
          onPress={() => router.push('/settings')}
          style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
          <Text style={[styles.primaryButtonLabel, { color: t.accent.fg }]}>Add a bridge</Text>
        </Pressable>
      </View>
    );
  }

  const renderChip = (id: string | null, label: string, color?: string, dot?: boolean) => {
    const selected = filterBridgeId === id;
    return (
      <Pressable
        key={id ?? 'all'}
        onPress={() => setFilterBridgeId(id)}
        style={[
          styles.chip,
          {
            backgroundColor: selected ? t.accent.primary : t.surface.raised,
            borderColor: selected ? t.accent.primary : t.border.subtle,
          },
        ]}>
        {color ? <View style={[styles.chipDot, { backgroundColor: color }]} /> : null}
        <Text
          style={[styles.chipLabel, { color: selected ? t.accent.fg : t.text.secondary }]}
          numberOfLines={1}>
          {label}
        </Text>
        {dot ? <View style={[styles.chipPending, { backgroundColor: t.status.warning }]} /> : null}
      </Pressable>
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerTitleAlign: 'left',
          headerTitle: 'Sessions',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable onPress={() => setFilterSheetVisible(true)} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} style={{ paddingHorizontal: space[2], paddingVertical: space[2] }}>
                <Ionicons
                  name={filters.length > 0 ? 'funnel' : 'funnel-outline'}
                  size={fontSize['2xl']}
                  color={filters.length > 0 ? t.accent.primary : t.text.primary}
                />
                {filters.length > 0 && (
                  <View style={{
                    position: 'absolute', top: space[1], right: space[1],
                    minWidth: 16, height: 16, borderRadius: 8,
                    backgroundColor: t.accent.primary,
                    alignItems: 'center', justifyContent: 'center',
                    paddingHorizontal: 3,
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: t.accent.fg }}>{filters.length}</Text>
                  </View>
                )}
              </Pressable>
              <Pressable onPress={cycleViewMode} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} style={{ paddingHorizontal: space[2], paddingVertical: space[2] }}>
                <Ionicons
                  name={viewMode === 'flat' ? 'list-outline' : 'layers-outline'}
                  size={fontSize['2xl']}
                  color={viewMode !== 'flat' ? t.accent.primary : t.text.primary}
                />
              </Pressable>
              <Pressable onPress={() => router.push('/machines' as Href)} hitSlop={12} style={{ paddingHorizontal: space[2] }}>
                <Ionicons name="hardware-chip-outline" size={fontSize['2xl']} color={t.text.primary} />
              </Pressable>
              <Pressable onPress={() => router.push('/settings')} hitSlop={12} style={{ paddingHorizontal: space[2] }}>
                <Ionicons name="settings-outline" size={fontSize.xl} color={t.text.primary} />
              </Pressable>
            </View>
          ),
        }}
      />
      <FlatList
        style={{ backgroundColor: t.surface.base }}
        contentContainerStyle={{ paddingVertical: 4 }}
        data={listItems}
        keyExtractor={(item) => {
          if ('_header' in item) return `header:${item.label}`;
          return `${item.bridgeId}:${item.agent}:${item.id}`;
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={t.text.primary} />
        }
        ListHeaderComponent={
          <View>
            {discoveryCandidates.length > 0 ? (
              <View style={[styles.discoverBanner, { backgroundColor: t.accent.primary }]}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={async () => {
                    for (const b of discoveryCandidates) await addBridge(b);
                    clearDiscovery();
                    void refresh();
                  }}>
                  <Text style={[styles.discoverText, { color: t.accent.fg }]}>
                    {discoveryCandidates.length} new machine
                    {discoveryCandidates.length === 1 ? '' : 's'} on your tailnet — tap to add
                  </Text>
                </Pressable>
                <Pressable onPress={clearDiscovery} hitSlop={8}>
                  <Ionicons name="close" size={fontSize.lg} color={t.accent.fg} />
                </Pressable>
              </View>
            ) : null}
            {orderedMachines.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipStrip}>
                {renderChip(null, 'All')}
                {orderedMachines.map((b) =>
                  renderChip(b.id, shortBridgeName(b), bridgeColor(b), machineHasPending(b.id)),
                )}
              </ScrollView>
            ) : null}
            {totalPending > 0 ? (
              <View
                style={[
                  styles.banner,
                  { backgroundColor: t.status.warningCardBg, borderColor: t.status.warning },
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
            <ImportProgressBanner />
          </View>
        }
        ListEmptyComponent={
          anyConnecting ? (
            <View style={styles.centered}>
              <ActivityIndicator />
            </View>
          ) : allOffline ? (
            <View style={styles.centered}>
              <View style={[styles.errorIcon, { backgroundColor: t.surface.raised }]}>
                <Ionicons name="cloud-offline-outline" size={30} color={t.text.secondary} />
              </View>
              <Text style={[styles.errorTitle, { color: t.text.primary }]}>
                Can't reach your machines
              </Text>
              <Text style={[styles.errorBody, { color: t.text.secondary }]}>
                Check that you're on the same tailnet and at least one bridge is running.
              </Text>
              <Pressable
                onPress={() => void refresh()}
                style={[styles.primaryButton, { backgroundColor: t.accent.primary }]}>
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
          if ('_header' in item) {
            return (
              <Pressable
                onPress={() => toggleRepo(item.label)}
                style={({ pressed }) => [
                  styles.groupHeader,
                  { borderBottomColor: t.border.subtle, backgroundColor: pressed ? t.surface.raised : t.surface.base },
                ]}>
                <Text style={[styles.groupHeaderLabel, { color: t.text.secondary, flex: 1 }]}>
                  {item.label}
                </Text>
                {item.collapsed ? (
                  <Text style={[styles.groupHeaderCount, { color: t.text.muted }]}>
                    {item.count} session{item.count === 1 ? '' : 's'}
                  </Text>
                ) : null}
                <Text style={[styles.groupHeaderChevron, { color: t.text.muted }]}>
                  {item.collapsed ? '▶' : '▼'}
                </Text>
              </Pressable>
            );
          }
          const badge = statusBadge(item, t);
          const title = item.label ?? item.projectName;
          const subtitle = item.label ? item.projectName : null;
          const k = pendingKey(item.bridgeId, item.agent, item.id);
          const itemsPending = pending[k] ?? [];
          const isExpanded = expanded.has(k);
          const bridge = bridgeById.get(item.bridgeId);
          const connStateForRow = connState[item.bridgeId];
          const offline = isOfflineState(connStateForRow);
          const footText =
            connStateForRow === 'unauthorised'
              ? 're-auth'
              : connStateForRow === 'offline'
                ? 'offline'
                : badge.label;
          const footColor = connStateForRow === 'unauthorised' ? t.status.danger : t.text.secondary;
          const pillColor = bridge ? bridgeColor(bridge) : t.text.muted;
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
                    if (!bridge) return;
                    try {
                      await renameSession(
                        bridgeToConfig(bridge),
                        item.agent,
                        item.id,
                        next === '' ? null : next,
                      );
                      void refreshBridge(item.bridgeId);
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
                onPress={() => router.push(`/sessions/${item.agent}/${item.id}?bridge=${item.bridgeId}`)}
                onLongPress={onRename}
                delayLongPress={350}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? t.surface.raised : 'transparent', borderBottomColor: t.border.subtle },
                  offline ? { opacity: 0.6 } : null,
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
                  <View style={styles.rowFooterLeft}>
                    <View style={[styles.machineDot, { backgroundColor: pillColor }]} />
                    <Text style={[styles.machineName, { color: t.text.muted }]} numberOfLines={1}>
                      {bridge?.name ?? item.bridgeId}
                    </Text>
                    <Text style={[styles.statusLabel, { color: footColor }]}>· {footText}</Text>
                  </View>
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
                        style={[styles.pendingChip, { backgroundColor: t.status.warning, borderColor: t.status.warning }]}>
                        <Text style={[styles.pendingChipLabel, { color: t.text.inverse }]}>
                          {itemsPending.length} approval{itemsPending.length === 1 ? '' : 's'} {isExpanded ? '▴' : '▾'}
                        </Text>
                      </Pressable>
                    ) : null}
                    {item.agent === 'claude-code' ? (
                      <ClaudeMark size={fontSize.lg} />
                    ) : (
                      <Text style={[styles.agentLabel, { color: t.text.muted }]}>{item.agent}</Text>
                    )}
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
                        style={[styles.pendingCard, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
                        <Text style={[styles.pendingTool, { color: t.text.primary }]}>{p.tool}</Text>
                        {summary ? (
                          <Text style={[styles.pendingSummary, { color: t.text.secondary }]} numberOfLines={3}>
                            {summary}
                          </Text>
                        ) : null}
                        <View style={styles.pendingActions}>
                          <Pressable
                            disabled={rowBusy}
                            onPress={() => decide(p, 'allow')}
                            style={({ pressed }) => [
                              styles.pendingButton,
                              { backgroundColor: pressed ? t.accent.pressed : t.accent.primary, opacity: rowBusy ? 0.5 : 1 },
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
                            <Text style={[styles.pendingButtonLabel, { color: t.text.primary }]}>Always</Text>
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
                          onPress={() => router.push(`/sessions/${p.agent}/${p.sessionId}?bridge=${item.bridgeId}`)}
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
      <SessionFilterSheet
        visible={filterSheetVisible}
        onClose={() => setFilterSheetVisible(false)}
        filters={filters}
        onAddFilter={addFilter}
        onRemoveFilter={removeFilter}
        onClearAll={clearFilters}
        sessions={Object.values(byBridge).flat()}
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
  discoverBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginHorizontal: space[3],
    marginTop: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
    borderRadius: radius.lg,
  },
  discoverText: { fontSize: fontSize.base, fontWeight: '700' },
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
  chipPending: { width: 6, height: 6, borderRadius: 3, marginLeft: 2 },
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
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth, marginTop: space[2] },
  groupHeaderLabel: { fontSize: fontSize.sm, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  groupHeaderCount: { fontSize: fontSize.sm },
  groupHeaderChevron: { fontSize: 10, width: 12, textAlign: 'center' },
  rowContainer: {},
  row: { paddingHorizontal: space[4], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  projectName: { fontSize: fontSize.xl, fontWeight: '600' },
  subtitle: { fontSize: fontSize.sm, marginTop: 1 },
  timestamp: { fontSize: fontSize.sm },
  preview: { fontSize: fontSize.md, lineHeight: 20 },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  rowFooterLeft: { flexDirection: 'row', alignItems: 'center', gap: space[1] + 2, flexShrink: 1 },
  rowFooterRight: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  machineDot: { width: 8, height: 8, borderRadius: 4 },
  machineName: { fontSize: fontSize.sm, fontWeight: '600', maxWidth: 120 },
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
