import { type TaggedSession } from '@/lib/aggregator';
import { bridgeColor, shortBridgeName, useBridges } from '@/lib/bridges';
import { fontSize, space, useTheme, type Theme } from '@/theme';
import { useMemo } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

export interface SessionsGroupedListProps {
  sessions: TaggedSession[];
  viewMode: 'grouped-alpha' | 'grouped-recency';
  currentAgent: string;
  currentSessionId: string;
  currentBridgeId: string;
  onSessionPress(session: TaggedSession): void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Section type ────────────────────────────────────────────────────────────

interface SessionSection {
  title: string;
  data: TaggedSession[];
  maxLastModified: number;
}

function buildSections(
  sessions: TaggedSession[],
  viewMode: 'grouped-alpha' | 'grouped-recency',
): SessionSection[] {
  // Group by projectName
  const grouped = new Map<string, TaggedSession[]>();
  for (const s of sessions) {
    const key = s.projectName;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(s);
    } else {
      grouped.set(key, [s]);
    }
  }

  // Build sections with maxLastModified
  const sections: SessionSection[] = [];
  for (const [title, data] of grouped) {
    const maxLastModified = Math.max(...data.map((s) => s.lastModified));
    // Sort sessions within each section by lastModified descending
    const sorted = [...data].sort((a, b) => b.lastModified - a.lastModified);
    sections.push({ title, data: sorted, maxLastModified });
  }

  // Sort sections by mode
  if (viewMode === 'grouped-alpha') {
    sections.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  } else {
    sections.sort((a, b) => b.maxLastModified - a.maxLastModified);
  }

  return sections;
}

// ─── SessionRow ──────────────────────────────────────────────────────────────

interface SessionRowProps {
  item: TaggedSession;
  isCurrent: boolean;
  t: Theme;
  bridgeColor: string;
  bridgeName: string;
  onPress(): void;
}

function SessionRow({ item, isCurrent, t, bridgeColor: bColor, bridgeName, onPress }: SessionRowProps) {
  const title = item.label ?? item.projectName;
  return (
    <Pressable
      onPress={onPress}
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
        {bridgeName ? (
          <>
            <View style={[styles.machineDot, { backgroundColor: bColor }]} />
            <Text style={[styles.machineName, { color: t.text.muted }]} numberOfLines={1}>
              {bridgeName}
            </Text>
          </>
        ) : null}
        {item.preview ? (
          <Text numberOfLines={1} style={[styles.preview, { color: t.text.secondary }]}>
            {bridgeName ? '· ' : ''}
            {item.preview}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SessionsGroupedList({
  sessions,
  viewMode,
  currentAgent,
  currentSessionId,
  currentBridgeId,
  onSessionPress,
}: SessionsGroupedListProps) {
  const t = useTheme();
  const bridges = useBridges();

  const bridgeById = useMemo(
    () => new Map(bridges.map((b) => [b.id, b])),
    [bridges],
  );

  const sections = useMemo(
    () => buildSections(sessions, viewMode),
    [sessions, viewMode],
  );

  return (
    <SectionList
      sections={sections}
      keyExtractor={(s) => `${s.bridgeId}:${s.agent}:${s.id}`}
      renderSectionHeader={({ section }) => (
        <View
          style={[
            styles.sectionHeader,
            {
              backgroundColor: t.surface.raised,
              borderBottomColor: t.border.subtle,
            },
          ]}>
          <Text
            style={[styles.sectionTitle, { color: t.text.secondary }]}
            numberOfLines={1}>
            {section.title}
          </Text>
          <Text style={[styles.sectionCount, { color: t.text.muted }]}>
            {section.data.length}
          </Text>
        </View>
      )}
      renderItem={({ item }) => {
        const isCurrent =
          item.agent === currentAgent &&
          item.id === currentSessionId &&
          item.bridgeId === currentBridgeId;
        const bridge = bridgeById.get(item.bridgeId);
        const bColor = bridge ? bridgeColor(bridge) : '';
        const bName = bridge ? shortBridgeName(bridge) : '';
        return (
          <SessionRow
            item={item}
            isCurrent={isCurrent}
            t={t}
            bridgeColor={bColor}
            bridgeName={bName}
            onPress={() => onSessionPress(item)}
          />
        );
      }}
      stickySectionHeadersEnabled
    />
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    flex: 1,
  },
  sectionCount: {
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
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
