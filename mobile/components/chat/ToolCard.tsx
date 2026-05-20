import { fontFamily, fontSize, radius, space, useTheme } from '@/theme';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AgentKind } from '@/lib/types';
import { pickToolCard } from './cardPacks';

interface ToolUseCardProps {
  agent: AgentKind;
  name: string;
  input: unknown;
  running?: boolean;
}

interface ToolResultCardProps {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Thin dispatcher: looks up the renderer for `(agent, name)` in the card-pack
 * registry and invokes it. The chat container only ever passes the session's
 * agent down — no string compares on `'claude-code'` happen here.
 */
export function ToolUseCard({ agent, name, input, running }: ToolUseCardProps) {
  const t = useTheme();
  const render = pickToolCard(agent, name);
  return <>{render({ agent, name, input, running, t })}</>;
}

/**
 * Tool result cards stay agent-neutral — there's no per-agent dressing for
 * "Bash exit code N" vs. "shell errored", and the chat suppresses non-error
 * results anyway. Errors get the shared danger-card treatment.
 */
export function ToolResultCard({ content, isError }: ToolResultCardProps) {
  const t = useTheme();
  const label = isError ? 'tool error' : 'tool result';
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: isError ? t.status.dangerCardBg : 'transparent',
          borderColor: isError ? t.status.danger : t.border.subtle,
        },
      ]}>
      <Text
        style={[
          styles.tag,
          { color: isError ? t.status.danger : t.text.secondary, borderColor: isError ? t.status.danger : t.border.subtle },
        ]}>
        {label}
      </Text>
      <CollapsibleMono text={asText(content) || '(no output)'} max={200} />
    </View>
  );
}

function CollapsibleMono({ text, max }: { text: string; max: number }) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > max;
  const visible = truncated && !expanded ? text.slice(0, max) : text;
  return (
    <View style={{ marginTop: 4 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={{ flexGrow: 0, flexShrink: 0 }}>
        <Text style={[styles.mono, { color: t.text.primary }]} selectable>
          {visible}
        </Text>
      </ScrollView>
      {truncated ? (
        <Pressable onPress={() => setExpanded((e) => !e)}>
          <Text style={[styles.expand, { color: t.accent.primary }]}>
            {expanded ? 'Collapse' : `Show ${text.length - max} more chars`}
          </Text>
        </Pressable>
      ) : null}
      {!truncated && text.length === 0 ? (
        <Text style={[styles.dimmed, { color: t.text.secondary }]}>(empty)</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.lg + 2,
    padding: space[3] - 2,
    gap: 4,
  },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[1.5],
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: radius.sm,
    fontSize: fontSize.xs - 1,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  mono: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 17 },
  dimmed: { fontSize: fontSize.sm, marginTop: 2 },
  expand: { fontSize: fontSize.sm, fontWeight: '500', marginTop: 4 },
});
