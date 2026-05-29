import { fontFamily, fontSize, space, useTheme, type Theme } from '@/theme';
import { Fragment, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PrismLight } from 'react-syntax-highlighter';
import { ensureLanguagesRegistered } from './languages';

/** Row height in px — exported so the file viewer's scroll-to-line math
 *  stays in lock-step with how tall each rendered line actually is. */
export const CODE_LINE_HEIGHT = 18;

type SyntaxKey = keyof Theme['code']['syntax'];

/** Prism emits token nodes whose `className` is e.g. `['token', 'keyword']`.
 *  Collapse the long tail of Prism classes onto our small palette. Anything
 *  not listed inherits the parent (default foreground) color. */
const CLASS_TO_KEY: Record<string, SyntaxKey> = {
  keyword: 'keyword',
  atrule: 'keyword',
  rule: 'keyword',
  important: 'keyword',
  selector: 'keyword',
  number: 'number',
  boolean: 'number',
  constant: 'number',
  unit: 'number',
  symbol: 'number',
  string: 'string',
  char: 'string',
  'attr-value': 'string',
  'template-string': 'string',
  comment: 'comment',
  prolog: 'comment',
  cdata: 'comment',
  doctype: 'comment',
  function: 'func',
  'function-variable': 'func',
  'class-name': 'func',
  'maybe-class-name': 'func',
  tag: 'tag',
  namespace: 'tag',
  deleted: 'tag',
  'attr-name': 'attr',
  property: 'attr',
  variable: 'attr',
  parameter: 'attr',
  punctuation: 'punctuation',
  operator: 'operator',
  entity: 'operator',
  url: 'operator',
  builtin: 'builtin',
  inserted: 'builtin',
  regex: 'regex',
};

/** Minimal shape of the hast nodes react-syntax-highlighter hands the
 *  renderer (one node per line when `wrapLines` is on, which the lib
 *  auto-enables once a custom `renderer` is supplied). */
type Node = {
  type: 'element' | 'text';
  value?: string | number;
  properties?: { className?: unknown[] };
  children?: Node[];
};

function colorForClasses(classes: unknown[] | undefined, t: Theme): string | undefined {
  if (!classes) return undefined;
  for (const c of classes) {
    if (typeof c !== 'string') continue;
    const key = CLASS_TO_KEY[c];
    if (key) return t.code.syntax[key];
  }
  return undefined;
}

/** Recursively turn a line's token tree into nested <Text> with colors.
 *  Nested Text inherits the parent color unless its own class overrides. */
function renderTokens(nodes: Node[] | undefined, t: Theme, inherited: string, keyBase: string): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => {
    if (node.type === 'text') {
      return <Fragment key={`${keyBase}-${i}`}>{String(node.value ?? '')}</Fragment>;
    }
    const color = colorForClasses(node.properties?.className, t) ?? inherited;
    return (
      <Text key={`${keyBase}-${i}`} style={{ color }}>
        {renderTokens(node.children, t, color, `${keyBase}-${i}`)}
      </Text>
    );
  });
}

interface Props {
  code: string;
  /** Registered Prism language id, or null to render un-highlighted. */
  language: string | null;
  /** 1-based line to highlight + (the screen) scrolls to. */
  targetLine?: number | null;
}

export function HighlightedCode({ code, language, targetLine }: Props) {
  const t = useTheme();
  ensureLanguagesRegistered();

  const lineCount = code.split('\n').length;
  const numWidth = String(lineCount).length;

  const lineRow = (lineNo: number, content: ReactNode) => {
    const isTarget = targetLine === lineNo;
    return (
      <View key={lineNo} style={[styles.row, isTarget ? { backgroundColor: t.diff.addBg } : null]}>
        <Text style={[styles.gutter, { color: t.code.gutter, width: numWidth * 9 + 12 }]}>
          {String(lineNo).padStart(numWidth, ' ')}
        </Text>
        <Text style={[styles.code, { color: t.code.fg }]} selectable>
          {content}
        </Text>
      </View>
    );
  };

  // Un-highlighted fallback: one plain row per line. Used for unknown
  // languages and as the structure the highlighted path mirrors.
  if (!language) {
    return (
      <View style={styles.body}>
        {code.split('\n').map((line, i) => lineRow(i + 1, line === '' ? ' ' : line))}
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <PrismLight
        language={language}
        useInlineStyles={false}
        PreTag={Passthrough}
        CodeTag={Passthrough}
        renderer={({ rows }: { rows: Node[] }) =>
          rows.map((row, i) => {
            const content = renderTokens(row.children, t, t.code.fg, `l${i}`);
            const isEmpty = !row.children || row.children.length === 0;
            return lineRow(i + 1, isEmpty ? ' ' : content);
          })
        }>
        {code}
      </PrismLight>
    </View>
  );
}

/** PreTag/CodeTag stand-ins: the lib wraps the renderer output in these and
 *  passes web props (style/className). We drop everything but children so no
 *  DOM-shaped props reach React Native. */
function Passthrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const styles = StyleSheet.create({
  body: { paddingVertical: space[2] },
  row: { flexDirection: 'row', paddingHorizontal: 6 },
  gutter: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    lineHeight: CODE_LINE_HEIGHT,
    textAlign: 'right',
    paddingRight: 8,
  },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: CODE_LINE_HEIGHT },
});
