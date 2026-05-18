import { fetchFile, type ScopedFile } from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import { fontFamily, fontSize, space, useTheme } from '@/theme';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export default function FileViewerScreen() {
  const { agent, id, path } = useLocalSearchParams<{ agent: string; id: string; path: string }>();
  const settings = useHydratedSettings();
  const t = useTheme();
  const [file, setFile] = useState<ScopedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const lines = useMemo(() => (file ? file.contents.split('\n') : []), [file]);
  const numWidth = useMemo(() => String(lines.length).length, [lines.length]);

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
          {file.rel || file.path} · {lines.length} lines · {Math.round(file.size / 1024)} KB
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
      <ScrollView showsVerticalScrollIndicator>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={{ paddingVertical: space[2] }}>
            {lines.map((line, i) => (
              <View key={i} style={styles.row}>
                <Text style={[styles.gutter, { color: t.code.gutter, width: numWidth * 9 + 12 }]}>
                  {String(i + 1).padStart(numWidth, ' ')}
                </Text>
                <Text style={[styles.code, { color: t.code.fg }]} selectable>
                  {line === '' ? ' ' : line}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
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
  row: { flexDirection: 'row', paddingHorizontal: 6 },
  gutter: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 18, textAlign: 'right', paddingRight: 8 },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 18 },
});
