import { fontFamily, fontSize, radius, space, useTheme } from '@/theme';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const MAX_VISIBLE_LINES = 30;

interface CodeBlockProps {
  text: string;
  lang?: string | null;
}

export function CodeBlock({ text, lang }: CodeBlockProps) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = text.split('\n');
  const tooLong = lines.length > MAX_VISIBLE_LINES;
  const visibleText = tooLong && !expanded ? lines.slice(0, MAX_VISIBLE_LINES).join('\n') : text;

  async function copy() {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: t.code.blockBg, borderColor: t.border.subtle },
      ]}>
      <View style={[styles.header, { borderBottomColor: t.border.subtle }]}>
        <Text style={[styles.lang, { color: t.text.secondary }]}>
          {lang ?? 'code'} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </Text>
        <Pressable hitSlop={8} onPress={copy}>
          <Text style={[styles.copy, { color: copied ? t.status.success : t.accent.primary }]}>
            {copied ? 'copied' : 'copy'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <Text selectable style={[styles.code, { color: t.code.fg }]}>
          {visibleText}
        </Text>
      </ScrollView>
      {tooLong ? (
        <Pressable onPress={() => setExpanded((e) => !e)} style={[styles.expandRow, { borderTopColor: t.border.subtle }]}>
          <Text style={[styles.expandLabel, { color: t.accent.primary }]}>
            {expanded ? `Collapse` : `Show all ${lines.length} lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginVertical: 4,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[1.5],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lang: { fontSize: fontSize.xs, fontWeight: '600', textTransform: 'lowercase', letterSpacing: 0.3 },
  copy: { fontSize: fontSize.sm, fontWeight: '600' },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.base,
    lineHeight: 18,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  expandRow: {
    paddingVertical: space[2],
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  expandLabel: { fontSize: fontSize.base, fontWeight: '500' },
});
