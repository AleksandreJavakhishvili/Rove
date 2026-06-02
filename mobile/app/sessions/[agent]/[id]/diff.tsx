import { InlineDiff } from '@/components/chat/InlineDiff';
import { fetchDiff, fetchGitDiffFile, type DiffFile, type SessionDiff } from '@/lib/bridge';
import { bridgeToConfig, useActiveBridge, useBridge, useHydratedBridges } from '@/lib/bridges';
import { fontFamily, fontSize, space, useTheme, type Theme } from '@/theme';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AgentKind } from '@/lib/types';

/** Discriminator for the screen's three render modes. */
type DiffMode =
  /** No `path` query — cumulative session diff vs baseline. */
  | { kind: 'cumulative' }
  /** `path=…` — per-file session diff vs baseline (Phase 2). */
  | { kind: 'session-file'; path: string }
  /** `source=git&path=…[&staged=true]` — git working-tree diff (Phase 4). */
  | { kind: 'git-file'; path: string; staged: boolean };

interface LoadedState {
  baseline: string | null;
  files: DiffFile[];
}

export default function DiffViewerScreen() {
  const params = useLocalSearchParams<{
    agent: string;
    id: string;
    path?: string;
    /** When `'git'`, the screen pulls from `/git/diff` instead of `/diff`. */
    source?: string;
    /** `'true'` → diff index vs HEAD (vs the default worktree vs HEAD). */
    staged?: string;
    /** Which bridge this session lives on; falls back to the active bridge. */
    bridge?: string;
  }>();
  const { agent, id } = params;
  const mode: DiffMode = (() => {
    const path = typeof params.path === 'string' && params.path !== '' ? params.path : null;
    if (path && params.source === 'git') {
      return {
        kind: 'git-file',
        path,
        staged: params.staged === 'true' || params.staged === '1',
      };
    }
    if (path) return { kind: 'session-file', path };
    return { kind: 'cumulative' };
  })();
  const focusPath = mode.kind === 'cumulative' ? null : mode.path;

  useHydratedBridges();
  const paramBridge = useBridge(typeof params.bridge === 'string' ? params.bridge : null);
  const activeBridge = useActiveBridge();
  const connBridge = paramBridge ?? activeBridge;
  const conn = connBridge
    ? bridgeToConfig(connBridge)
    : { baseUrl: '', token: undefined as string | undefined };
  const t = useTheme();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!conn.baseUrl || !agent || !id) return;
    let cancelled = false;

    const apply = (state: LoadedState) => {
      if (cancelled) return;
      setLoaded(state);
      if (state.files.length > 0) {
        if (focusPath) {
          setExpanded(new Set(state.files.map((f) => f.newPath || f.oldPath)));
        } else {
          const firstFile = state.files[0];
          if (firstFile) setExpanded(new Set([firstFile.newPath || firstFile.oldPath]));
        }
      }
    };
    const fail = (err: unknown) => {
      if (cancelled) return;
      setError(String((err as Error).message ?? err));
    };

    if (mode.kind === 'git-file') {
      fetchGitDiffFile(
        conn,
        agent,
        id,
        mode.path,
        { staged: mode.staged },
      )
        .then((res) => apply({ baseline: null, files: res.file ? [res.file] : [] }))
        .catch(fail);
    } else {
      fetchDiff(
        conn,
        agent,
        id,
        focusPath ? { path: focusPath } : {},
      )
        .then((d: SessionDiff) => apply({ baseline: d.baseline, files: d.files }))
        .catch(fail);
    }

    return () => {
      cancelled = true;
    };
    // mode.kind / mode.staged / focusPath cover every input that changes the
    // fetch shape; primitive deps keep this from refetching on cosmetic
    // re-renders.
  }, [conn.baseUrl, conn.token, agent, id, mode.kind, focusPath, mode.kind === 'git-file' ? mode.staged : false]);

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <Text style={{ color: t.status.danger, fontSize: fontSize.lg }}>{error}</Text>
      </View>
    );
  }
  if (!loaded) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const totalAdded = loaded.files.reduce((acc, f) => acc + f.added, 0);
  const totalRemoved = loaded.files.reduce((acc, f) => acc + f.removed, 0);
  // Title rules: per-file modes show the basename. Git-staged adds a hint
  // so the user knows which slice they're looking at.
  const screenTitle = (() => {
    if (mode.kind === 'cumulative') return 'Diff';
    const base = focusPath?.split('/').pop() ?? 'Diff';
    if (mode.kind === 'git-file' && mode.staged) return `${base} · staged`;
    if (mode.kind === 'git-file') return `${base} · git`;
    return base;
  })();

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const emptyMessage = (() => {
    if (mode.kind === 'cumulative') return 'No changes since baseline.';
    if (mode.kind === 'session-file') return `No changes for ${focusPath} since baseline.`;
    if (mode.kind === 'git-file' && mode.staged) return `No staged changes for ${focusPath}.`;
    return `No unstaged changes for ${focusPath}.`;
  })();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.surface.base }}>
      <Stack.Screen options={{ title: screenTitle, headerBackTitle: 'Back' }} />
      {mode.kind === 'cumulative' ? (
        <View style={[styles.summary, { borderBottomColor: t.border.subtle }]}>
          <Text style={[styles.summaryText, { color: t.text.secondary }]}>
            {loaded.files.length} files ·{' '}
            <Text style={{ color: t.status.success }}>+{totalAdded}</Text>{' '}
            <Text style={{ color: t.status.danger }}>−{totalRemoved}</Text>
            {loaded.baseline ? `\nbaseline ${loaded.baseline.slice(0, 7)}` : '\nworking tree'}
          </Text>
        </View>
      ) : null}
      {loaded.files.length === 0 ? (
        <View style={styles.centered}>
          <Text style={{ color: t.text.secondary }}>{emptyMessage}</Text>
        </View>
      ) : mode.kind !== 'cumulative' ? (
        // Per-file mode: render via the shared <InlineDiff> so the route
        // and the chat tool cards stay visually aligned. Prefetched, so
        // <InlineDiff> doesn't re-fetch the same payload we just pulled.
        <View style={{ paddingHorizontal: space[3], paddingTop: space[2] }}>
          {loaded.files.map((file) => (
            <InlineDiff
              key={file.newPath || file.oldPath}
              agent={agent as AgentKind}
              sessionId={id}
              path={file.newPath || file.oldPath}
              prefetched={file}
              collapsed={false}
            />
          ))}
        </View>
      ) : (
        loaded.files.map((file) => {
          const path = file.newPath || file.oldPath;
          const isOpen = expanded.has(path);
          return <FileSection key={path} file={file} isOpen={isOpen} onToggle={() => toggle(path)} t={t} />;
        })
      )}
    </ScrollView>
  );
}

function FileSection({
  file,
  isOpen,
  onToggle,
  t,
}: {
  file: DiffFile;
  isOpen: boolean;
  onToggle: () => void;
  t: Theme;
}) {
  const path = file.newPath || file.oldPath;
  const statusColor =
    file.status === 'added' ? t.status.success : file.status === 'deleted' ? t.status.danger : t.text.secondary;

  return (
    <View style={[styles.fileBlock, { borderTopColor: t.border.subtle }]}>
      <Pressable onPress={onToggle} style={styles.fileHeader}>
        <Text style={[styles.statusBadge, { color: statusColor, borderColor: statusColor }]}>
          {file.status[0]?.toUpperCase()}
        </Text>
        <Text style={[styles.filePath, { color: t.text.primary }]} numberOfLines={1}>
          {path}
        </Text>
        <Text style={[styles.fileStats, { color: t.text.secondary }]}>
          <Text style={{ color: t.status.success }}>+{file.added}</Text>{' '}
          <Text style={{ color: t.status.danger }}>−{file.removed}</Text>
        </Text>
      </Pressable>
      {isOpen ? (
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hunksScroll}>
          <View>
            {file.binary ? (
              <Text style={[styles.binaryNote, { color: t.text.secondary }]}>(binary file)</Text>
            ) : (
              file.hunks.map((h, hi) => (
                <View key={hi}>
                  <Text style={[styles.hunkHeader, { color: t.text.muted }]}>{h.header}</Text>
                  {h.lines.map((l, li) => {
                    let bg = 'transparent';
                    let marker = ' ';
                    let color = t.diff.contextFg;
                    if (l.op === 'add') {
                      bg = t.diff.addBg;
                      marker = '+';
                      color = t.diff.addFg;
                    } else if (l.op === 'remove') {
                      bg = t.diff.removeBg;
                      marker = '−';
                      color = t.diff.removeFg;
                    }
                    return (
                      <View key={li} style={[styles.diffRow, { backgroundColor: bg }]}>
                        <Text style={[styles.marker, { color }]}>{marker}</Text>
                        <Text style={[styles.codeText, { color }]} selectable>
                          {l.text === '' ? ' ' : l.text}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { padding: space[8], alignItems: 'center', justifyContent: 'center' },
  summary: { paddingHorizontal: space[4], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth },
  summaryText: { fontSize: fontSize.base, lineHeight: 19 },
  fileBlock: { borderTopWidth: StyleSheet.hairlineWidth },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
    gap: 10,
  },
  statusBadge: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 19,
    fontWeight: '700',
    fontSize: fontSize.xs,
  },
  filePath: { flex: 1, fontSize: fontSize.md, fontWeight: '500', fontFamily: fontFamily.mono },
  fileStats: { fontSize: fontSize.sm, fontFamily: fontFamily.mono },
  hunksScroll: { paddingBottom: space[2] },
  hunkHeader: { fontFamily: fontFamily.mono, fontSize: fontSize.xs, paddingHorizontal: space[2], paddingVertical: 4 },
  diffRow: { flexDirection: 'row', paddingHorizontal: 4 },
  marker: { width: 18, fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 18, textAlign: 'center' },
  codeText: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 18 },
  binaryNote: { fontStyle: 'italic', paddingHorizontal: space[3], paddingVertical: 6, fontSize: fontSize.base },
});
