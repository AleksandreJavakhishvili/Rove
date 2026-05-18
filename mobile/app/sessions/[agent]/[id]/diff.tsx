import { fetchDiff, type DiffFile, type SessionDiff } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import { fontFamily, fontSize, space, useTheme, type Theme } from '@/theme';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export default function DiffViewerScreen() {
  const { agent, id } = useLocalSearchParams<{ agent: string; id: string }>();
  const settings = useHydratedSettings();
  const t = useTheme();
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!settings.baseUrl || !agent || !id) return;
    let cancelled = false;
    fetchDiff({ baseUrl: settings.baseUrl, token: settings.token }, agent, id)
      .then((d) => {
        if (!cancelled) {
          setDiff(d);
          if (d.files.length > 0) {
            const firstFile = d.files[0];
            if (firstFile) setExpanded(new Set([firstFile.newPath || firstFile.oldPath]));
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error).message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [settings.baseUrl, settings.token, agent, id]);

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <Text style={{ color: t.status.danger, fontSize: fontSize.lg }}>{error}</Text>
      </View>
    );
  }
  if (!diff) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const totalAdded = diff.files.reduce((acc, f) => acc + f.added, 0);
  const totalRemoved = diff.files.reduce((acc, f) => acc + f.removed, 0);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.surface.base }}>
      <Stack.Screen options={{ title: 'Diff', headerBackTitle: 'Back' }} />
      <View style={[styles.summary, { borderBottomColor: t.border.subtle }]}>
        <Text style={[styles.summaryText, { color: t.text.secondary }]}>
          {diff.files.length} files ·{' '}
          <Text style={{ color: t.status.success }}>+{totalAdded}</Text>{' '}
          <Text style={{ color: t.status.danger }}>−{totalRemoved}</Text>
          {diff.baseline ? `\nbaseline ${diff.baseline.slice(0, 7)}` : '\nworking tree'}
        </Text>
      </View>
      {diff.files.length === 0 ? (
        <View style={styles.centered}>
          <Text style={{ color: t.text.secondary }}>No changes since baseline.</Text>
        </View>
      ) : (
        diff.files.map((file) => {
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
