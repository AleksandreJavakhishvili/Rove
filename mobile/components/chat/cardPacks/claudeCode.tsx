import type { Theme } from '@/theme';
import { fontFamily, fontSize, radius, space } from '@/theme';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Diff } from '../Diff';
import { InlineDiff } from '../InlineDiff';
import type { ToolCardContext, ToolCardRenderer } from './types';

function obj(input: unknown): Record<string, unknown> {
  return (input ?? {}) as Record<string, unknown>;
}

function previewPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  return p;
}

/** MCP tools follow the `mcp__<server>__<tool>` naming convention. Strip the
 *  namespace and surface "<server> · <tool>" so a generic card reads cleanly
 *  regardless of which MCP server emitted it — no per-tool special-casing.
 *  Non-MCP names pass through unchanged. */
function humanizeToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 3) {
      const server = parts[1].replace(/_/g, ' ');
      const tool = parts.slice(2).join(' ').replace(/_/g, ' ');
      return `${server} · ${tool}`;
    }
  }
  return name;
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

function Card({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <View style={[styles.card, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
      {children}
    </View>
  );
}

function Header({ t, label, running, runningLabel }: { t: Theme; label: string; running?: boolean; runningLabel?: string }) {
  return (
    <View style={styles.header}>
      <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>{label}</Text>
      {running ? <Text style={[styles.running, { color: t.text.secondary }]}>{runningLabel ?? 'running…'}</Text> : null}
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

function PromptToggle({ text, t }: { text: string; t: Theme }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)}>
        <Text style={[styles.expand, { color: t.accent.primary }]}>Show prompt ({text.length} chars)</Text>
      </Pressable>
    );
  }
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={{ marginTop: 4, flexGrow: 0, flexShrink: 0 }}>
        <Text style={[styles.mono, { color: t.text.primary }]} selectable>
          {text}
        </Text>
      </ScrollView>
      <Pressable onPress={() => setOpen(false)}>
        <Text style={[styles.expand, { color: t.accent.primary }]}>Hide prompt</Text>
      </Pressable>
    </View>
  );
}

function CollapsibleMono({ text, max, t }: { text: string; max: number; t: Theme }) {
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

/** Tool input shown collapsed by default. For generic/MCP tools the raw args
 *  are developer detail, not glanceable info — the tool name carries the
 *  signal, so we keep the payload one tap away instead of dumping it. */
function CollapsedInput({ text, t }: { text: string; t: Theme }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} style={{ marginTop: 4 }}>
        <Text style={[styles.expand, { color: t.accent.primary }]}>Show input</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ marginTop: 4 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator style={{ flexGrow: 0, flexShrink: 0 }}>
        <Text style={[styles.mono, { color: t.text.primary }]} selectable>
          {text}
        </Text>
      </ScrollView>
      <Pressable onPress={() => setOpen(false)}>
        <Text style={[styles.expand, { color: t.accent.primary }]}>Hide input</Text>
      </Pressable>
    </View>
  );
}

// ── Per-tool renderers ───────────────────────────────────────────────────────

const renderRead: ToolCardRenderer = ({ name, input, running, t }) => {
  const o = obj(input);
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
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
};

const renderEdit: ToolCardRenderer = ({ agent, sessionId, name, input, running, t }) => {
  const o = obj(input);
  const filePath = typeof o.file_path === 'string' ? o.file_path : null;
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
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
      {/* Inline diff against the session baseline — confirms the edit
       *  actually landed on disk. The input.old/new_string blocks above
       *  show the *intended* change; this shows the *applied* change. */}
      {filePath && !running ? (
        <InlineDiff
          agent={agent}
          sessionId={sessionId}
          path={normalizeFilePath(filePath)}
          collapsed
        />
      ) : null}
    </Card>
  );
};

const renderWrite: ToolCardRenderer = ({ agent, sessionId, name, input, running, t }) => {
  const o = obj(input);
  const filePath = typeof o.file_path === 'string' ? o.file_path : null;
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
      <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
        {previewPath(o.file_path)}
      </Text>
      {typeof o.content === 'string' ? <CollapsibleMono text={o.content} max={300} t={t} /> : null}
      {filePath && !running ? (
        <InlineDiff
          agent={agent}
          sessionId={sessionId}
          path={normalizeFilePath(filePath)}
          collapsed
        />
      ) : null}
    </Card>
  );
};

const renderNotebookEdit: ToolCardRenderer = ({ agent, sessionId, name, input, running, t }) => {
  const o = obj(input);
  // NotebookEdit uses `notebook_path` rather than `file_path`. The diff is
  // against the .ipynb file itself — noisy because JSON, but better than
  // nothing.
  const filePath = typeof o.notebook_path === 'string' ? o.notebook_path : null;
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
      <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
        {previewPath(o.notebook_path)}
      </Text>
      {typeof o.cell_id === 'string' ? (
        <Text style={[styles.dimmed, { color: t.text.secondary }]}>cell {o.cell_id}</Text>
      ) : null}
      {filePath && !running ? (
        <InlineDiff
          agent={agent}
          sessionId={sessionId}
          path={normalizeFilePath(filePath)}
          collapsed
        />
      ) : null}
    </Card>
  );
};

/**
 * Edit / Write / MultiEdit inputs sometimes carry absolute paths (claude
 * usually does) and sometimes carry repo-relative paths. The bridge's
 * `/diff?path=` filter compares against git's `newPath`, which is always
 * repo-relative POSIX. Strip a leading slash if present so the inline
 * diff doesn't show a permanent "No diff vs baseline" caption for absolute
 * paths that match a real changed file under cwd.
 *
 * Note: this doesn't try to be clever about path → cwd mapping. If the
 * agent passes `/Users/x/proj/src/foo.ts` and cwd is `/Users/x/proj`,
 * the bridge's filter compares `/Users/x/proj/src/foo.ts` to git's
 * `src/foo.ts` and misses. That's a known limitation — the inline diff
 * will gracefully degrade to "No diff vs baseline · <path>" and the user
 * still has the input.old/new_string preview above. Phase 8 (chat ↔
 * file backlinks) can fix this properly by tracking absolute paths and
 * resolving them through the session's cwd.
 */
function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

const renderBash: ToolCardRenderer = ({ input, running, t }) => {
  const o = obj(input);
  const cmd = String(o.command ?? '');
  const description = typeof o.description === 'string' ? o.description : null;
  const background = Boolean(o.run_in_background);
  const timeoutMs = typeof o.timeout === 'number' ? o.timeout : undefined;
  return (
    <Card t={t}>
      <Header t={t} label={background ? 'Bash · background' : 'Bash'} running={running} />
      {description ? <Text style={[styles.dimmed, { color: t.text.secondary }]}>{description}</Text> : null}
      {timeoutMs ? (
        <Text style={[styles.dimmed, { color: t.text.secondary }]}>timeout {Math.round(timeoutMs / 1000)}s</Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={{ marginTop: 4, flexGrow: 0, flexShrink: 0 }}>
        <Text style={[styles.cmd, { color: t.text.primary }]} selectable>
          $ {cmd}
        </Text>
      </ScrollView>
    </Card>
  );
};

const renderBashOutput: ToolCardRenderer = ({ input, running, t }) => {
  const o = obj(input);
  const shellId = String(o.bash_id ?? o.shell_id ?? '');
  const filter = typeof o.filter === 'string' ? o.filter : null;
  return (
    <Card t={t}>
      <Header t={t} label="BashOutput" running={running} runningLabel="polling…" />
      <Text style={[styles.dimmed, { color: t.text.secondary }]}>shell {shellId || '?'}</Text>
      {filter ? <Text style={[styles.dimmed, { color: t.text.secondary }]}>filter /{filter}/</Text> : null}
    </Card>
  );
};

const renderKill: ToolCardRenderer = ({ name, input, t }) => {
  const o = obj(input);
  const shellId = String(o.bash_id ?? o.shell_id ?? '');
  return (
    <Card t={t}>
      <View style={styles.header}>
        <Text style={[styles.tag, { color: t.status.danger, borderColor: t.status.danger }]}>{name}</Text>
      </View>
      <Text style={[styles.dimmed, { color: t.text.secondary }]}>stop shell {shellId || '?'}</Text>
    </Card>
  );
};

const renderGrepGlob: ToolCardRenderer = ({ name, input, running, t }) => {
  const o = obj(input);
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
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
};

const renderTodoWrite: ToolCardRenderer = ({ input, running, t }) => {
  const o = obj(input);
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
        {todos.map((td, i) => (
          <TodoRow key={i} todo={td} t={t} />
        ))}
      </View>
    </Card>
  );
};

const renderTask: ToolCardRenderer = ({ name, input, running, t }) => {
  const o = obj(input);
  const subagent = typeof o.subagent_type === 'string' ? o.subagent_type : 'general-purpose';
  const description = typeof o.description === 'string' ? o.description : '';
  const prompt = typeof o.prompt === 'string' ? o.prompt : '';
  return (
    <Card t={t}>
      <View style={styles.header}>
        <Text style={[styles.tag, { color: t.text.secondary, borderColor: t.border.subtle }]}>
          {name} · {subagent}
        </Text>
        {running ? <Text style={[styles.running, { color: t.text.secondary }]}>running…</Text> : null}
      </View>
      {description ? (
        <Text style={[styles.path, { color: t.text.primary }]} numberOfLines={2}>
          {description}
        </Text>
      ) : null}
      {prompt ? <PromptToggle text={prompt} t={t} /> : null}
    </Card>
  );
};

const renderWeb: ToolCardRenderer = ({ name, input, running, t }) => {
  const o = obj(input);
  const value = String(o.url ?? o.query ?? '');
  return (
    <Card t={t}>
      <Header t={t} label={name} running={running} />
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
};

/** The claude-code tool card pack — exported as a map so the registry in
 *  `cardPacks/index.ts` can look up renderers by name without an
 *  agent-specific switch in the chat container. */
export const claudeCodeCards: Record<string, ToolCardRenderer> = {
  Read: renderRead,
  Edit: renderEdit,
  MultiEdit: renderEdit,
  Write: renderWrite,
  NotebookEdit: renderNotebookEdit,
  Bash: renderBash,
  BashOutput: renderBashOutput,
  KillShell: renderKill,
  KillBash: renderKill,
  Grep: renderGrepGlob,
  Glob: renderGrepGlob,
  TodoWrite: renderTodoWrite,
  Task: renderTask,
  Agent: renderTask,
  WebFetch: renderWeb,
  WebSearch: renderWeb,
};

/** Fallback used by the generic card too — exposed so the registry's
 *  `GenericFallbackCard` matches the claude-code visual style. */
export function renderGenericCard(ctx: ToolCardContext) {
  return (
    <Card t={ctx.t}>
      <Header t={ctx.t} label={humanizeToolName(ctx.name)} running={ctx.running} />
      <CollapsedInput text={asText(ctx.input)} t={ctx.t} />
    </Card>
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
