import type { DiffFile } from '@/lib/bridge';
import { getInlineDiff } from '@/lib/diffCache';
import { useHydratedSettings } from '@/lib/store';
import type { AgentKind } from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme } from '@/theme';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/** Maximum visible lines in the default (collapsed) state. Picked to keep
 *  the card height bounded on a phone — most edits are well under this. */
const COLLAPSED_MAX_LINES = 30;

/** Debounce for the lazy fetch on mount. Multiple Edit / MultiEdit cards
 *  mounting in the same frame (e.g. on history replay) coalesce — the
 *  cache + in-flight dedup do the heavy lifting; this debounce just keeps
 *  the very-tight burst from queueing N microtasks. */
const FETCH_DEBOUNCE_MS = 150;

export interface InlineDiffProps {
  agent: AgentKind;
  sessionId: string;
  /** Relative POSIX path under the session cwd. */
  path: string;
  /** Default visual mode. The user can tap to toggle. */
  collapsed?: boolean;
  /**
   * When provided, render this exact diff without fetching. Used by the
   * per-file diff route to avoid a redundant network round-trip after it
   * already pulled the same data.
   */
  prefetched?: DiffFile;
  /** When false, suppress the long-press-to-open-file gesture. Used by
   *  the per-file diff screen itself (already inside the file viewer's
   *  cousin route). */
  enableFileViewerLink?: boolean;
}

export function InlineDiff({
  agent,
  sessionId,
  path,
  collapsed = true,
  prefetched,
  enableFileViewerLink = true,
}: InlineDiffProps) {
  const t = useTheme();
  const settings = useHydratedSettings();
  const [file, setFile] = useState<DiffFile | null | undefined>(
    prefetched !== undefined ? prefetched : undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(collapsed);

  useEffect(() => {
    if (prefetched !== undefined) {
      setFile(prefetched);
      setError(null);
      return;
    }
    if (!settings.baseUrl) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getInlineDiff(
        { baseUrl: settings.baseUrl, token: settings.token },
        agent,
        sessionId,
        path,
      )
        .then((f) => {
          if (cancelled) return;
          setFile(f);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(String((err as Error).message ?? err));
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent, sessionId, path, settings.baseUrl, settings.token, prefetched]);

  const onOpenFileViewer = () => {
    if (!enableFileViewerLink) return;
    router.push(`/sessions/${agent}/${sessionId}/file?path=${encodeURIComponent(path)}`);
  };

  // Order matters for TS narrowing — after these early returns `file` is a
  // concrete `DiffFile`. Error wins over still-loading because if we got
  // both (race / stale error), surfacing the error is more useful.
  if (error) {
    return (
      <View style={[styles.shell, { backgroundColor: t.surface.sunken, borderColor: t.border.subtle }]}>
        <Text style={[styles.caption, { color: t.text.muted }]} numberOfLines={2}>
          Preview unavailable · {path}
        </Text>
      </View>
    );
  }

  if (file === undefined) {
    return (
      <View style={[styles.shell, { backgroundColor: t.surface.sunken, borderColor: t.border.subtle }]}>
        <ActivityIndicator size="small" color={t.text.secondary} />
        <Text style={[styles.caption, { color: t.text.secondary }]} numberOfLines={1}>
          Loading preview…
        </Text>
      </View>
    );
  }

  if (file === null) {
    return (
      <View style={[styles.shell, { backgroundColor: t.surface.sunken, borderColor: t.border.subtle }]}>
        <Text style={[styles.caption, { color: t.text.muted }]} numberOfLines={1}>
          No diff vs baseline · {path}
        </Text>
      </View>
    );
  }

  if (file.binary) {
    return (
      <View style={[styles.shell, { backgroundColor: t.surface.sunken, borderColor: t.border.subtle }]}>
        <Text style={[styles.caption, { color: t.text.secondary }]}>(binary file)</Text>
      </View>
    );
  }

  // Build a flat array of lines from all hunks, with hunk headers as
  // synthetic "context" rows so the collapsed view still shows hunk
  // boundaries when there are several.
  const allRows: Array<
    | { kind: 'header'; text: string }
    | { kind: 'line'; op: 'context' | 'add' | 'remove'; text: string }
  > = [];
  for (const h of file.hunks) {
    allRows.push({ kind: 'header', text: h.header });
    for (const l of h.lines) {
      allRows.push({ kind: 'line', op: l.op, text: l.text });
    }
  }

  const visible =
    isCollapsed && allRows.length > COLLAPSED_MAX_LINES
      ? compactCollapsed(allRows, COLLAPSED_MAX_LINES)
      : allRows;
  const truncated = visible.length < allRows.length;

  return (
    <Pressable
      onPress={() => setIsCollapsed((c) => !c)}
      onLongPress={onOpenFileViewer}
      delayLongPress={350}
      style={[
        styles.shell,
        {
          backgroundColor: t.surface.sunken,
          borderColor: t.border.subtle,
        },
      ]}>
      <View style={styles.statRow}>
        <Text style={[styles.statBadge, { color: t.text.secondary }]} numberOfLines={1}>
          {path.split('/').pop()}
        </Text>
        <Text style={[styles.stat, { color: t.status.success }]}>+{file.added}</Text>
        <Text style={[styles.stat, { color: t.status.danger }]}>−{file.removed}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hunksScroll}>
        <View>
          {visible.map((r, i) => {
            if (r.kind === 'header') {
              return (
                <Text key={`h-${i}`} style={[styles.hunkHeader, { color: t.text.muted }]}>
                  {r.text}
                </Text>
              );
            }
            let bg = 'transparent';
            let marker = ' ';
            let color = t.diff.contextFg;
            if (r.op === 'add') {
              bg = t.diff.addBg;
              marker = '+';
              color = t.diff.addFg;
            } else if (r.op === 'remove') {
              bg = t.diff.removeBg;
              marker = '−';
              color = t.diff.removeFg;
            }
            return (
              <View key={`l-${i}`} style={[styles.diffRow, { backgroundColor: bg }]}>
                <Text style={[styles.marker, { color }]}>{marker}</Text>
                <Text style={[styles.codeText, { color }]} selectable>
                  {r.text === '' ? ' ' : r.text}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      {truncated || (allRows.length > COLLAPSED_MAX_LINES && !isCollapsed) ? (
        <Text style={[styles.toggle, { color: t.accent.primary }]}>
          {isCollapsed ? `Tap to show all ${allRows.length} lines` : 'Tap to collapse'}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Keep every add/remove line plus a small context window around each.
 * Goal: a phone-sized preview that doesn't elide the meaningful changes.
 * If the budget is exhausted before we cover everything, append a "…N
 * more lines" sentinel as a header row so the truncation is obvious.
 */
function compactCollapsed<
  R extends
    | { kind: 'header'; text: string }
    | { kind: 'line'; op: 'context' | 'add' | 'remove'; text: string }
>(rows: R[], budget: number): R[] {
  const out: R[] = [];
  const ctxWindow = 2;
  const keep = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.kind === 'header') {
      keep.add(i);
      continue;
    }
    if (r.op === 'add' || r.op === 'remove') {
      keep.add(i);
      for (let d = 1; d <= ctxWindow; d++) {
        if (i - d >= 0) keep.add(i - d);
        if (i + d < rows.length) keep.add(i + d);
      }
    }
  }
  let used = 0;
  let lastIndex = -2;
  for (let i = 0; i < rows.length; i++) {
    if (!keep.has(i)) continue;
    if (used >= budget) {
      const remaining = rows.length - i;
      if (remaining > 0) {
        out.push({ kind: 'header', text: `… ${remaining} more lines (tap to expand)` } as R);
      }
      break;
    }
    if (lastIndex >= 0 && i > lastIndex + 1) {
      // Insert an ellipsis row between non-contiguous kept ranges.
      out.push({ kind: 'header', text: '…' } as R);
    }
    const r = rows[i];
    if (r) out.push(r);
    used += 1;
    lastIndex = i;
  }
  return out;
}

const styles = StyleSheet.create({
  shell: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: space[1.5],
    paddingHorizontal: space[2],
    marginTop: 6,
    gap: 4,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  statBadge: {
    flex: 1,
    fontSize: fontSize.xs,
    fontFamily: fontFamily.mono,
  },
  stat: { fontSize: fontSize.xs, fontFamily: fontFamily.mono, fontWeight: '700' },
  hunksScroll: { paddingBottom: 2 },
  hunkHeader: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  diffRow: { flexDirection: 'row', paddingHorizontal: 2 },
  marker: {
    width: 14,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    lineHeight: 16,
    textAlign: 'center',
  },
  codeText: { fontFamily: fontFamily.mono, fontSize: fontSize.xs, lineHeight: 16 },
  caption: { fontSize: fontSize.xs, fontStyle: 'italic' },
  toggle: { fontSize: fontSize.xs, fontWeight: '600', marginTop: 2 },
});
