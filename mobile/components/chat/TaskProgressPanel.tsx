import { fontFamily, fontSize, space, useTheme } from '@/theme';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/** One entry of a Claude Code `TodoWrite` call. Loosely typed because the
 *  payload arrives as the raw tool input over the wire. */
export interface TaskTodo {
  content?: string;
  /** Present-tense label shown while the item is `in_progress`. */
  activeForm?: string;
  status?: string;
}

export interface TaskProgressPanelProps {
  /** Latest TodoWrite state. The panel is the single live view of these;
   *  the chat container hides the corresponding inline card. */
  todos: TaskTodo[];
  /** True while a turn is in flight — drives the live timer + "updating…". */
  running: boolean;
  /** Live elapsed ms for the in-flight run (only meaningful while running). */
  elapsedMs: number;
  /** Final wall-clock of the last completed run, shown when idle. */
  lastDurationMs?: number;
  /** Total tokens from the last completed run, shown when idle. The SDK only
   *  reports usage at the end of a run, so live token counts aren't shown. */
  lastTokens?: number;
  /** Model label for the status line, when known. */
  model?: string;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Sticky task/progress panel pinned above the input row. Mirrors the
 * Claude Code terminal's live checklist: the most recent TodoWrite state
 * with a status line (done/total · model · time · tokens). Stays visible
 * after a run completes so the final time + token totals remain readable;
 * collapsible so it never crowds the chat.
 */
export function TaskProgressPanel({
  todos,
  running,
  elapsedMs,
  lastDurationMs,
  lastTokens,
  model,
}: TaskProgressPanelProps) {
  const t = useTheme();
  // On mobile the panel sits right above the input, so default it collapsed to
  // keep the keyboard area uncluttered; the user can tap the header to expand.
  // On web there's more vertical room, so start expanded.
  const [collapsed, setCollapsed] = useState(Platform.OS !== 'web');
  const done = todos.filter((td) => td?.status === 'completed').length;
  const total = todos.length;

  // While running we show the live timer; when idle we fall back to the last
  // run's final duration + token total.
  const timeText = running
    ? fmtDuration(elapsedMs)
    : lastDurationMs !== undefined
      ? fmtDuration(lastDurationMs)
      : null;
  const tokenText = !running && lastTokens !== undefined ? `${fmtTokens(lastTokens)} tokens` : null;

  const metaParts = [`${done}/${total}`, model ?? null, timeText, tokenText].filter(
    Boolean,
  ) as string[];

  return (
    <View style={[styles.wrap, { backgroundColor: t.surface.sunken, borderTopColor: t.border.subtle }]}>
      <Pressable onPress={() => setCollapsed((c) => !c)} style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={[styles.title, { color: t.text.primary }]}>Tasks</Text>
          <Text style={[styles.meta, { color: t.text.secondary }]} numberOfLines={1}>
            {metaParts.join('  ·  ')}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {running ? (
            <Text style={[styles.updating, { color: t.accent.primary }]}>updating…</Text>
          ) : null}
          <Text style={[styles.toggle, { color: t.text.secondary }]}>{collapsed ? '▸' : '▾'}</Text>
        </View>
      </Pressable>
      {!collapsed ? (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ gap: 2, paddingBottom: space[1] }}
          nestedScrollEnabled
          showsVerticalScrollIndicator>
          {todos.map((td, i) => {
            const status =
              td?.status === 'completed'
                ? 'completed'
                : td?.status === 'in_progress'
                  ? 'in_progress'
                  : 'pending';
            const text =
              status === 'in_progress' && typeof td?.activeForm === 'string'
                ? td.activeForm
                : td?.content ?? '';
            const color =
              status === 'completed'
                ? t.text.muted
                : status === 'in_progress'
                  ? t.accent.primary
                  : t.text.secondary;
            const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';
            return (
              <View key={i} style={styles.row}>
                <Text style={[styles.mark, { color }]}>{mark}</Text>
                <Text
                  style={[
                    styles.todoText,
                    { color },
                    status === 'completed' ? styles.done : null,
                  ]}
                  numberOfLines={2}>
                  {text}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[3],
    paddingTop: space[2],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  headerLeft: { flexDirection: 'row', alignItems: 'baseline', gap: space[2], flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { fontSize: fontSize.sm, fontWeight: '700' },
  meta: { fontSize: fontSize.xs, fontFamily: fontFamily.mono, flexShrink: 1 },
  updating: { fontSize: fontSize.xs, fontWeight: '600' },
  toggle: { fontSize: fontSize.md, fontWeight: '600' },
  list: { maxHeight: 168, marginTop: space[1] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  mark: { fontSize: fontSize.base, lineHeight: 19, width: 16, textAlign: 'center' },
  todoText: { flex: 1, fontSize: fontSize.sm, lineHeight: 19 },
  done: { textDecorationLine: 'line-through' },
});
