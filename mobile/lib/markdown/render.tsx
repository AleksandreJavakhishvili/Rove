/**
 * React Native renderer for the block/span tokens produced by `parseMarkdown`.
 *
 * The renderer deliberately avoids any layout that could stretch a row's
 * height: every block sizes to its content, no flex:1 anywhere. That's the
 * whole reason we wrote this in-house instead of using
 * `react-native-markdown-display`, whose internals inflated FlatList rows and
 * caused later items to be virtualized out.
 */
import { CodeBlock } from '@/components/chat/CodeBlock';
import { fontFamily, fontSize, lineHeight, useTheme, type Theme } from '@/theme';
import type { ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { Block, Span } from './parse';

export interface RenderOptions {
  color: string;
}

export function renderBlocks(blocks: Block[], opts: RenderOptions): ReactNode {
  return blocks.map((block, i) => (
    <BlockView key={i} block={block} color={opts.color} isFirst={i === 0} />
  ));
}

function BlockView({ block, color, isFirst }: { block: Block; color: string; isFirst: boolean }) {
  const t = useTheme();
  const s = useStyles(t, color);
  const topMargin = isFirst ? 0 : 8;

  switch (block.kind) {
    case 'paragraph':
      return (
        <Text style={[s.paragraph, { marginTop: topMargin }]} selectable>
          {renderSpans(block.spans, s)}
        </Text>
      );
    case 'fence':
      return (
        <View style={{ marginTop: topMargin }}>
          <CodeBlock text={block.text} lang={block.lang} />
        </View>
      );
    case 'heading': {
      const headingStyle = [s.h1, s.h2, s.h3, s.h4, s.h5, s.h6][block.level - 1]!;
      return (
        <Text style={[headingStyle, { marginTop: topMargin }]} selectable>
          {renderSpans(block.spans, s)}
        </Text>
      );
    }
    case 'list':
      return (
        <View style={{ marginTop: topMargin, gap: 4 }}>
          {block.items.map((item, i) => (
            <View key={i} style={s.listItem}>
              <Text style={s.listMarker}>{block.ordered ? `${i + 1}.` : '•'}</Text>
              <Text style={s.listContent} selectable>
                {renderSpans(item, s)}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'hr':
      return <View style={[s.hr, { marginTop: topMargin }]} />;
  }
}

/**
 * Render inline spans into Text children. Plain text spans emit raw strings so
 * the host Text doesn't end up with an unnecessary nested `<Text>` for every
 * unstyled run — that nesting was the suspected culprit behind a bubble-height
 * inflation we saw in some FlatList items.
 */
function renderSpans(spans: Span[], s: ReturnType<typeof useStyles>): ReactNode {
  return spans.map((span, i) => {
    switch (span.kind) {
      case 'text':
        return span.text;
      case 'bold':
        return (
          <Text key={i} style={s.bold}>
            {span.text}
          </Text>
        );
      case 'italic':
        return (
          <Text key={i} style={s.italic}>
            {span.text}
          </Text>
        );
      case 'code':
        return (
          <Text key={i} style={s.codeInline}>
            {span.text}
          </Text>
        );
      case 'link':
        return (
          <Text
            key={i}
            style={s.link}
            onPress={() => {
              Linking.openURL(span.href).catch(() => undefined);
            }}>
            {span.text}
          </Text>
        );
    }
  });
}

function useStyles(t: Theme, color: string) {
  return StyleSheet.create({
    paragraph: {
      color,
      fontSize: fontSize.lg,
      lineHeight: fontSize.lg * lineHeight.body,
    },
    bold: { color, fontWeight: '700' },
    italic: { color, fontStyle: 'italic' },
    codeInline: {
      color,
      backgroundColor: t.code.inlineBg,
      fontFamily: fontFamily.mono,
      fontSize: fontSize.base,
    },
    link: { color: t.accent.primary, textDecorationLine: 'underline' },
    h1: { color, fontSize: fontSize['3xl'], fontWeight: '700', lineHeight: fontSize['3xl'] * 1.2 },
    h2: { color, fontSize: fontSize['2xl'], fontWeight: '700', lineHeight: fontSize['2xl'] * 1.2 },
    h3: { color, fontSize: fontSize.xl, fontWeight: '700', lineHeight: fontSize.xl * 1.2 },
    h4: { color, fontSize: fontSize.lg, fontWeight: '700', lineHeight: fontSize.lg * 1.25 },
    h5: { color, fontSize: fontSize.md, fontWeight: '600', lineHeight: fontSize.md * 1.3 },
    h6: { color, fontSize: fontSize.base, fontWeight: '600', lineHeight: fontSize.base * 1.3 },
    listItem: { flexDirection: 'row', alignItems: 'flex-start' },
    listMarker: {
      color,
      fontSize: fontSize.lg,
      lineHeight: fontSize.lg * lineHeight.body,
      minWidth: 22,
    },
    listContent: {
      color,
      fontSize: fontSize.lg,
      lineHeight: fontSize.lg * lineHeight.body,
      flexShrink: 1,
    },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: t.text.muted, opacity: 0.4 },
  });
}

