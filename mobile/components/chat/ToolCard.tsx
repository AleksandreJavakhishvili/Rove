import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Diff } from './Diff';

interface ToolUseCardProps {
  name: string;
  input: unknown;
  running?: boolean;
}

interface ToolResultCardProps {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
}

function obj(input: unknown): Record<string, unknown> {
  return (input ?? {}) as Record<string, unknown>;
}

function previewPath(p: unknown, cwd?: string): string {
  if (typeof p !== 'string') return '';
  if (cwd && p.startsWith(cwd)) return p.slice(cwd.length).replace(/^\//, '');
  return p;
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

export function ToolUseCard({ name, input, running }: ToolUseCardProps) {
  const t = useTheme();
  const o = obj(input);

  const header = (
    <View style={styles.header}>
      <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>{name}</Text>
      {running ? <Text style={[styles.running, { color: t.text.secondary }]}>running…</Text> : null}
    </View>
  );

  switch (name) {
    case 'Read':
      return (
        <Card t={t}>
          {header}
          <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
            {previewPath(o.file_path)}
          </Text>
          {o.offset || o.limit ? (
            <Text style={[styles.dimmed, { color: t.text.secondary }]}>
              lines {String(o.offset ?? 1)}–
              {o.limit ? String(Number(o.offset ?? 0) + Number(o.limit)) : '…'}
            </Text>
          ) : null}
        </Card>
      );
    case 'Edit':
    case 'MultiEdit':
      return (
        <Card t={t}>
          {header}
          <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
            {previewPath(o.file_path)}
          </Text>
          {name === 'Edit' && typeof o.old_string === 'string' && typeof o.new_string === 'string' ? (
            <Diff oldStr={o.old_string} newStr={o.new_string} />
          ) : null}
          {name === 'MultiEdit' && Array.isArray(o.edits)
            ? (o.edits as any[]).map((e, i) => (
                <View key={i} style={{ marginTop: 6 }}>
                  <Text style={[styles.dimmed, { color: t.text.secondary }]}>edit {i + 1}</Text>
                  <Diff oldStr={String(e?.old_string ?? '')} newStr={String(e?.new_string ?? '')} />
                </View>
              ))
            : null}
        </Card>
      );
    case 'Write':
      return (
        <Card t={t}>
          {header}
          <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
            {previewPath(o.file_path)}
          </Text>
          {typeof o.content === 'string' ? <CollapsibleMono text={o.content} max={300} t={t} /> : null}
        </Card>
      );
    case 'Bash': {
      const cmd = String(o.command ?? '');
      const description = typeof o.description === 'string' ? o.description : null;
      const background = Boolean(o.run_in_background);
      const timeoutMs = typeof o.timeout === 'number' ? o.timeout : undefined;
      return (
        <Card t={t}>
          <View style={styles.header}>
            <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>
              {background ? 'Bash · background' : 'Bash'}
            </Text>
            {running ? <Text style={[styles.running, { color: t.text.secondary }]}>running…</Text> : null}
          </View>
          {description ? <Text style={[styles.dimmed, { color: t.text.secondary }]}>{description}</Text> : null}
          {timeoutMs ? (
            <Text style={[styles.dimmed, { color: t.text.secondary }]}>timeout {Math.round(timeoutMs / 1000)}s</Text>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator style={{ marginTop: 4 }}>
            <Text style={[styles.cmd, { color: t.text.primary }]} selectable>
              $ {cmd}
            </Text>
          </ScrollView>
        </Card>
      );
    }
    case 'BashOutput': {
      const shellId = String(o.bash_id ?? o.shell_id ?? '');
      const filter = typeof o.filter === 'string' ? o.filter : null;
      return (
        <Card t={t}>
          <View style={styles.header}>
            <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>
              BashOutput
            </Text>
            {running ? <Text style={[styles.running, { color: t.text.secondary }]}>polling…</Text> : null}
          </View>
          <Text style={[styles.dimmed, { color: t.text.secondary }]}>shell {shellId || '?'}</Text>
          {filter ? (
            <Text style={[styles.dimmed, { color: t.text.secondary }]}>filter /{filter}/</Text>
          ) : null}
        </Card>
      );
    }
    case 'KillShell':
    case 'KillBash': {
      const shellId = String(o.bash_id ?? o.shell_id ?? '');
      return (
        <Card t={t}>
          <View style={styles.header}>
            <Text style={[styles.tag, { color: t.status.danger, borderColor: t.status.danger }]}>
              {name}
            </Text>
          </View>
          <Text style={[styles.dimmed, { color: t.text.secondary }]}>stop shell {shellId || '?'}</Text>
        </Card>
      );
    }
    case 'Grep':
    case 'Glob':
      return (
        <Card t={t}>
          {header}
          <Text style={[styles.cmd, { color: t.text.primary }]} selectable>
            {String(o.pattern ?? '')}
          </Text>
          {o.path ? (
            <Text style={[styles.dimmed, { color: t.text.secondary }]} numberOfLines={1}>
              in {previewPath(o.path)}
            </Text>
          ) : null}
        </Card>
      );
    case 'TodoWrite': {
      const todos = Array.isArray(o.todos) ? (o.todos as any[]) : [];
      const done = todos.filter((td) => td?.status === 'completed').length;
      return (
        <Card t={t}>
          <View style={styles.header}>
            <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>
              Todos {done}/{todos.length}
            </Text>
            {running ? <Text style={[styles.running, { color: t.text.secondary }]}>updating…</Text> : null}
          </View>
          <View style={{ marginTop: 4, gap: 2 }}>
            {todos.map((td, i) => <TodoRow key={i} todo={td} t={t} />)}
          </View>
        </Card>
      );
    }
    case 'Task': {
      const subagent = typeof o.subagent_type === 'string' ? o.subagent_type : 'general-purpose';
      const description = typeof o.description === 'string' ? o.description : '';
      const prompt = typeof o.prompt === 'string' ? o.prompt : '';
      return (
        <Card t={t}>
          <View style={styles.header}>
            <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>
              Task · {subagent}
            </Text>
            {running ? <Text style={[styles.running, { color: t.text.secondary }]}>running…</Text> : null}
          </View>
          {description ? (
            <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
          {prompt ? <CollapsibleMono text={prompt} max={240} t={t} /> : null}
        </Card>
      );
    }
    case 'WebFetch':
    case 'WebSearch': {
      const value = String(o.url ?? o.query ?? '');
      return (
        <Card t={t}>
          {header}
          <Text style={[styles.cmd, { color: t.text.primary }]} selectable numberOfLines={2}>
            {value}
          </Text>
          {typeof o.prompt === 'string' ? (
            <Text style={[styles.dimmed, { color: t.text.secondary }]} numberOfLines={2}>
              {o.prompt}
            </Text>
          ) : null}
        </Card>
      );
    }
    default:
      return (
        <Card t={t}>
          {header}
          <CollapsibleMono text={asText(input)} max={400} t={t} />
        </Card>
      );
  }
}

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
      <CollapsibleMono text={asText(content) || '(no output)'} max={400} t={t} />
    </View>
  );
}

function Card({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <View style={[styles.card, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
      {children}
    </View>
  );
}

function TodoRow({ todo, t }: { todo: any; t: Theme }) {
  const status = todo?.status === 'completed' ? 'completed' : todo?.status === 'in_progress' ? 'in_progress' : 'pending';
  const text = String(
    status === 'in_progress' && typeof todo?.activeForm === 'string' ? todo.activeForm : todo?.content ?? '',
  );
  const mark = status === 'completed' ? '☑' : status === 'in_progress' ? '◉' : '☐';
  const color =
    status === 'completed' ? t.text.muted : status === 'in_progress' ? t.accent.primary : t.text.primary;
  const strike = status === 'completed' ? ({ textDecorationLine: 'line-through' as const }) : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      <Text style={[styles.todoMark, { color }]}>{mark}</Text>
      <Text style={[styles.todoText, { color }, strike]}>{text}</Text>
    </View>
  );
}

function CollapsibleMono({ text, max, t }: { text: string; max: number; t: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > max;
  const visible = truncated && !expanded ? text.slice(0, max) : text;
  return (
    <View style={{ marginTop: 4 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  running: { fontSize: fontSize.sm },
  path: { fontFamily: fontFamily.mono, fontSize: fontSize.base, marginTop: 2 },
  cmd: { fontFamily: fontFamily.mono, fontSize: fontSize.base },
  mono: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 17 },
  dimmed: { fontSize: fontSize.sm, marginTop: 2 },
  expand: { fontSize: fontSize.sm, fontWeight: '500', marginTop: 4 },
  todoMark: { fontSize: fontSize.base, lineHeight: 19, width: 16, textAlign: 'center' },
  todoText: { flex: 1, fontSize: fontSize.base, lineHeight: 19 },
});
