import { fontFamily, fontSize, lineHeight, radius, useTheme } from '@/theme';
import { useMemo } from 'react';
import { Linking, StyleSheet } from 'react-native';
import MarkdownDisplay, { type ASTNode } from 'react-native-markdown-display';
import { CodeBlock } from './CodeBlock';

interface MarkdownProps {
  text: string;
  color: string;
}

export function Markdown({ text, color }: MarkdownProps) {
  const t = useTheme();
  const muted = t.text.secondary;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          color,
          fontSize: fontSize.lg,
          lineHeight: fontSize.lg * lineHeight.body,
          backgroundColor: 'transparent',
        },
        paragraph: { color, marginTop: 0, marginBottom: 6 },
        text: { color },
        heading1: { color, fontSize: fontSize['3xl'], fontWeight: '700', marginTop: 8, marginBottom: 6 },
        heading2: { color, fontSize: fontSize['2xl'], fontWeight: '700', marginTop: 8, marginBottom: 6 },
        heading3: { color, fontSize: fontSize.xl, fontWeight: '700', marginTop: 6, marginBottom: 4 },
        heading4: { color, fontSize: fontSize.lg, fontWeight: '700', marginTop: 6, marginBottom: 4 },
        heading5: { color, fontSize: fontSize.lg, fontWeight: '600', marginTop: 4, marginBottom: 4 },
        heading6: { color, fontSize: fontSize.md, fontWeight: '600', marginTop: 4, marginBottom: 4 },
        strong: { color, fontWeight: '700' },
        em: { color, fontStyle: 'italic' },
        s: { color, textDecorationLine: 'line-through' },
        link: { color: t.accent.primary, textDecorationLine: 'underline' },
        blockquote: {
          backgroundColor: t.code.inlineBg,
          borderLeftWidth: 3,
          borderLeftColor: muted,
          paddingLeft: 10,
          paddingRight: 10,
          paddingVertical: 6,
          marginVertical: 6,
          borderRadius: radius.sm,
        },
        bullet_list: { marginVertical: 4 },
        ordered_list: { marginVertical: 4 },
        list_item: { color, marginVertical: 2, flexDirection: 'row' },
        bullet_list_icon: { color, marginRight: 6, marginTop: 8 },
        bullet_list_content: { flex: 1, color },
        ordered_list_icon: { color, marginRight: 6, marginTop: 4 },
        ordered_list_content: { flex: 1, color },
        hr: { backgroundColor: muted, height: StyleSheet.hairlineWidth, marginVertical: 8 },
        code_inline: {
          color,
          backgroundColor: t.code.inlineBg,
          fontFamily: fontFamily.mono,
          fontSize: fontSize.base,
          paddingHorizontal: 4,
          borderRadius: radius.sm - 1,
        },
        code_block: {
          color,
          backgroundColor: t.code.inlineBg,
          fontFamily: fontFamily.mono,
          fontSize: fontSize.base,
          padding: 8,
          borderRadius: radius.md,
        },
        fence: {
          color,
          backgroundColor: t.code.inlineBg,
          fontFamily: fontFamily.mono,
          fontSize: fontSize.base,
          padding: 8,
          borderRadius: radius.md,
        },
        table: { borderColor: muted, borderWidth: StyleSheet.hairlineWidth, marginVertical: 6 },
        thead: { backgroundColor: t.surface.raised },
        tbody: { backgroundColor: 'transparent' },
        th: { color, padding: 6, fontWeight: '700' },
        td: { color, padding: 6 },
        tr: { borderBottomColor: muted, borderBottomWidth: StyleSheet.hairlineWidth },
      }),
    [color, muted, t.accent.primary, t.code.inlineBg, t.surface.raised],
  );

  const rules = useMemo(
    () => ({
      fence: (node: ASTNode) => {
        const info = (node as { sourceInfo?: string }).sourceInfo;
        const lang = typeof info === 'string' && info.length > 0 ? info.split(/\s+/)[0] ?? null : null;
        return <CodeBlock key={node.key} text={node.content ?? ''} lang={lang} />;
      },
    }),
    [],
  );

  return (
    <MarkdownDisplay
      style={styles}
      rules={rules}
      onLinkPress={(url) => {
        Linking.openURL(url).catch(() => undefined);
        return false;
      }}>
      {text}
    </MarkdownDisplay>
  );
}
