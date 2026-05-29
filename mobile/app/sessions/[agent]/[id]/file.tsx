import { Markdown } from '@/components/chat/Markdown';
import { CODE_LINE_HEIGHT, HighlightedCode } from '@/components/highlight/HighlightedCode';
import { languageForPath } from '@/components/highlight/languages';
import { fetchFile, type ScopedFile } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import { fontSize, space, useTheme } from '@/theme';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export default function FileViewerScreen() {
  const { agent, id, path, line: lineParam } = useLocalSearchParams<{
    agent: string;
    id: string;
    path: string;
    /** When set, the viewer scrolls to + highlights this 1-based line. */
    line?: string;
  }>();
  const targetLine = (() => {
    const n = typeof lineParam === 'string' ? Number.parseInt(lineParam, 10) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : null;
  })();
  const settings = useHydratedSettings();
  const t = useTheme();
  const [file, setFile] = useState<ScopedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const verticalScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!settings.baseUrl || !agent || !id || !path) return;
    let cancelled = false;
    fetchFile({ baseUrl: settings.baseUrl, token: settings.token }, agent, id, path)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error).message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [settings.baseUrl, settings.token, agent, id, path]);

  const lineCount = useMemo(() => (file ? file.contents.split('\n').length : 0), [file]);
  const language = useMemo(
    () => (file ? languageForPath(file.rel || file.path) : null),
    [file],
  );
  const isMarkdown = language === 'markdown';

  // Scroll-to-line on mount when `?line=N` is set. Runs once after the
  // file lands (we need lines to exist for the math to be meaningful)
  // and adds a small top margin so the target line isn't flush under
  // the meta bar.
  useEffect(() => {
    if (!file || targetLine === null || isMarkdown) return;
    // Use a microtask so the ScrollView has rendered its inner content
    // before we ask it to jump.
    const handle = setTimeout(() => {
      const y = Math.max(0, (targetLine - 1) * CODE_LINE_HEIGHT - 80);
      verticalScrollRef.current?.scrollTo({ y, animated: false });
    }, 50);
    return () => clearTimeout(handle);
  }, [file, targetLine, isMarkdown]);

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <Text style={{ color: t.status.danger, fontSize: fontSize.lg }}>{error}</Text>
      </View>
    );
  }
  if (!file) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  async function copyAll() {
    if (!file) return;
    await Clipboard.setStringAsync(file.contents);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const title = file.rel || file.path.split('/').pop() || 'file';

  return (
    <View style={{ flex: 1, backgroundColor: t.surface.base }}>
      <Stack.Screen options={{ title, headerBackTitle: 'Back' }} />
      <View style={[styles.metaBar, { borderBottomColor: t.border.subtle }]}>
        <Text style={[styles.metaText, { color: t.text.secondary }]} numberOfLines={1}>
          {file.rel || file.path} · {lineCount} lines · {Math.round(file.size / 1024)} KB
          {file.truncated ? ' · truncated' : ''}
        </Text>
        <Pressable hitSlop={8} onPress={copyAll}>
          <Text
            style={{
              color: copied ? t.status.success : t.accent.primary,
              fontWeight: '600',
              fontSize: fontSize.base,
            }}>
            {copied ? 'copied' : 'copy'}
          </Text>
        </Pressable>
      </View>
      {isMarkdown ? (
        <ScrollView
          contentContainerStyle={styles.markdownBody}
          showsVerticalScrollIndicator>
          <Markdown text={file.contents} color={t.text.primary} />
        </ScrollView>
      ) : (
        <ScrollView ref={verticalScrollRef} showsVerticalScrollIndicator>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <HighlightedCode code={file.contents} language={language} targetLine={targetLine} />
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  metaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  metaText: { fontSize: fontSize.sm, flex: 1 },
  markdownBody: { paddingHorizontal: space[4], paddingVertical: space[3] },
});
