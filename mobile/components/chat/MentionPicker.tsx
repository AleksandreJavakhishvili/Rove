import { fetchTree } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import { TREE_ENTRY_KIND, type AgentKind, type TreeEntry } from '@/lib/types';
import { fontFamily, fontSize, space, useTheme } from '@/theme';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/** Hard cap on rows the picker renders. Anything beyond is hidden — the
 *  user can type more characters to narrow. */
const MAX_RESULTS = 30;

/** Recursive `/tree` depth requested on first open. 4 is enough to reach
 *  most files in a typical project without flooding the response. */
const TREE_DEPTH = 4;

/** Tree responses are cached client-side for this long so subsequent
 *  `@`-token edits don't re-fetch. Invalidated explicitly via `refreshKey`. */
const CACHE_TTL_MS = 30_000;

/** Match an `@<token>` immediately to the left of the caret. The token may
 *  not contain whitespace, but everything else (slashes, dots, hyphens) is
 *  fair game so paths like `@src/foo/bar.ts` round-trip cleanly. */
const TOKEN_RE = /(?:^|\s)@([^\s]*)$/;

export interface MentionPickerProps {
  agent: AgentKind;
  sessionId: string;
  draft: string;
  /** Caret offset in `draft`. Picker reads chars to the left of caret. */
  caret: number;
  /**
   * Bumped by the parent each time a `file_changed` event lands so the
   * cached tree gets re-fetched on the next open. Pass `0` if you don't
   * care about live invalidation; the TTL still kicks in.
   */
  refreshKey?: number;
  /** Replace the partial `@…` token with `insertion` (already includes `@`). */
  onPick: (insertion: string, replaceRange: { start: number; end: number }) => void;
}

interface ActiveToken {
  /** Characters after the `@`, before the caret. May be empty. */
  query: string;
  /** Index of `@` in the draft. */
  start: number;
  /** Caret position (exclusive end of the replaced range). */
  end: number;
}

function findActiveToken(draft: string, caret: number): ActiveToken | null {
  if (caret < 0 || caret > draft.length) return null;
  const upToCaret = draft.slice(0, caret);
  const m = upToCaret.match(TOKEN_RE);
  if (!m) return null;
  const text = m[1];
  if (text === undefined) return null;
  const atIndex = upToCaret.length - text.length - 1;
  return { query: text, start: atIndex, end: caret };
}

interface CacheEntry {
  fetchedAt: number;
  refreshKey: number;
  files: TreeEntry[];
}

// Process-wide cache so navigating away and back to the same chat reuses
// the tree. Keyed by (agent, sessionId).
const treeCache = new Map<string, CacheEntry>();
function cacheKey(agent: string, sessionId: string): string {
  return `${agent}::${sessionId}`;
}

function rankEntries(entries: TreeEntry[], query: string): TreeEntry[] {
  if (!query) return entries.slice(0, MAX_RESULTS);
  const q = query.toLowerCase();
  const scored: Array<{ e: TreeEntry; score: number }> = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const path = e.path.toLowerCase();
    let score = -1;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (path.includes(q)) score = 40;
    if (score < 0) continue;
    // Penalize deeper / longer paths within the same bucket so a
    // top-level match wins over a deeply-nested one with the same
    // basename score.
    score -= Math.min(20, Math.floor(path.length / 4));
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.e);
}

export function MentionPicker({
  agent,
  sessionId,
  draft,
  caret,
  refreshKey = 0,
  onPick,
}: MentionPickerProps) {
  const t = useTheme();
  const settings = useHydratedSettings();
  const token = useMemo(() => findActiveToken(draft, caret), [draft, caret]);
  const hasToken = token !== null;

  const [files, setFiles] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hasToken) return; // no fetch until user actually types `@`
    if (!settings.baseUrl) return;
    const key = cacheKey(agent, sessionId);
    const cached = treeCache.get(key);
    if (
      cached &&
      cached.refreshKey === refreshKey &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS
    ) {
      setFiles(cached.files);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchTree(
      { baseUrl: settings.baseUrl, token: settings.token },
      agent,
      sessionId,
      { depth: TREE_DEPTH },
    )
      .then((listing) => {
        if (cancelled) return;
        const onlyFiles = listing.entries.filter((e) => e.kind === TREE_ENTRY_KIND.file);
        treeCache.set(key, { fetchedAt: Date.now(), refreshKey, files: onlyFiles });
        setFiles(onlyFiles);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String((err as Error).message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken, agent, sessionId, settings.baseUrl, settings.token, refreshKey]);

  if (!token) return null;

  const matches = files ? rankEntries(files, token.query) : [];

  if (loading && matches.length === 0) {
    return (
      <View
        style={[
          styles.bar,
          { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken },
        ]}>
        <ActivityIndicator size="small" color={t.text.secondary} />
        <Text style={[styles.muted, { color: t.text.secondary }]}>Loading files…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View
        style={[
          styles.bar,
          { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken },
        ]}>
        <Text style={[styles.muted, { color: t.status.danger }]} numberOfLines={2}>
          {error}
        </Text>
      </View>
    );
  }
  if (matches.length === 0) {
    return (
      <View
        style={[
          styles.bar,
          { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken },
        ]}>
        <Text style={[styles.muted, { color: t.text.muted }]}>No matching files</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.list,
        { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken },
      ]}>
      <FlatList
        data={matches}
        keyExtractor={(e) => e.path}
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onPick(`@${item.path}`, { start: token.start, end: token.end })}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
            ]}>
            <Text style={[styles.basename, { color: t.text.primary }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.dim, { color: t.text.secondary }]} numberOfLines={1}>
              {item.path}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  list: {
    maxHeight: 220,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  row: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 2,
  },
  basename: { fontSize: fontSize.base, fontWeight: '600' },
  dim: { fontSize: fontSize.xs, fontFamily: fontFamily.mono },
  muted: { fontSize: fontSize.sm, fontStyle: 'italic' },
});
