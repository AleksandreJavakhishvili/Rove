import { ApprovalSheet, type PendingApproval } from '@/components/chat/ApprovalSheet';
import { ChatPreviewPager } from '@/components/chat/ChatPreviewPager';
import { Markdown } from '@/components/chat/Markdown';
import { PreviewPane } from '@/components/chat/PreviewPane';
import { ToolResultCard, ToolUseCard } from '@/components/chat/ToolCard';
import {
  fetchHistory,
  fetchSessionInfo,
  openStream,
  renameSession,
  takeOwnership,
  type ConnectionState,
} from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import {
  captureAndUploadPhoto,
  pickAndUploadDocument,
  pickAndUploadImage,
  type UploadResult,
} from '@/lib/uploads';
import type { AgentEvent, HistoryEntry, SessionStatus } from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { useHeaderHeight } from '@react-navigation/elements';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

interface SlashCmd {
  name: string;
  hint: string;
}

const SLASH_COMMANDS: SlashCmd[] = [
  { name: '/compact', hint: 'Summarize older turns to free context' },
  { name: '/cost', hint: 'Show token usage and spend' },
  { name: '/model', hint: 'Switch model' },
  { name: '/help', hint: 'List available commands' },
  { name: '/agents', hint: 'Manage agents' },
  { name: '/mcp', hint: 'Manage MCP servers' },
  { name: '/clear', hint: 'Reset conversation context' },
  { name: '/init', hint: 'Initialize a CLAUDE.md for the project' },
];

type ChatItem =
  | { id: string; kind: 'user'; text: string; live?: boolean; parentToolUseId?: string }
  | { id: string; kind: 'assistant'; text: string; live?: boolean; parentToolUseId?: string }
  | {
      id: string;
      kind: 'tool_use';
      name: string;
      toolUseId: string;
      input: unknown;
      running?: boolean;
      live?: boolean;
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: 'tool_result';
      toolUseId: string;
      content: unknown;
      isError?: boolean;
      live?: boolean;
      parentToolUseId?: string;
    }
  | { id: string; kind: 'meta'; text: string }
  | { id: string; kind: 'takeover_prompt'; pids: number[]; pendingMessage: string };

function entryToChatItem(e: HistoryEntry, index: number): ChatItem | null {
  switch (e.kind) {
    case 'user': {
      const text = extractText(e.content);
      if (!text.trim()) return null;
      return { id: `h-${index}-${e.uuid}`, kind: 'user', text, parentToolUseId: e.parentToolUseId };
    }
    case 'assistant': {
      const text = extractText(e.content);
      if (!text.trim()) return null;
      return { id: `h-${index}-${e.uuid}`, kind: 'assistant', text, parentToolUseId: e.parentToolUseId };
    }
    case 'tool_use':
      return {
        id: `h-${index}-${e.uuid}`,
        kind: 'tool_use',
        name: e.name,
        toolUseId: e.toolUseId,
        input: e.input,
        parentToolUseId: e.parentToolUseId,
      };
    case 'tool_result': {
      const text = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '');
      if (!e.isError && !text.trim()) return null;
      return {
        id: `h-${index}-${e.uuid}`,
        kind: 'tool_result',
        toolUseId: e.toolUseId,
        content: e.content,
        isError: e.isError,
        parentToolUseId: e.parentToolUseId,
      };
    }
    case 'system':
      return null;
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.text ?? b?.content ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Claude's background-bash tool_result contains a shell id like `bash_1` or
// `shell_a3f` somewhere in the text. Extract it so we can link subsequent
// BashOutput / KillShell calls back to their originating Bash card.
function extractShellId(content: unknown): string | null {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const m = text.match(/\b(bash_[A-Za-z0-9_-]+|shell_[A-Za-z0-9_-]+)\b/);
  return m ? m[1] : null;
}

function readBashId(input: unknown): string | null {
  const o = (input ?? {}) as Record<string, unknown>;
  const v = o.bash_id ?? o.shell_id;
  return typeof v === 'string' ? v : null;
}

// Tools where the success tool_result is just "ok"/"file modified"/etc. and
// adds no signal beyond the tool_use card. We always render errors regardless.
const QUIET_RESULT_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Ls',
  'LS',
  'WebSearch',
  'WebFetch',
  'Edit',
  'MultiEdit',
  'Write',
  'TodoWrite',
  'Task',
]);

function opStyle(op: 'add' | 'change' | 'unlink', t: Theme): { color: string; symbol: string } {
  if (op === 'add') return { color: t.op.add, symbol: 'A' };
  if (op === 'unlink') return { color: t.op.unlink, symbol: 'D' };
  return { color: t.op.change, symbol: 'M' };
}

export default function ChatScreen() {
  const { agent, id } = useLocalSearchParams<{ agent: string; id: string }>();
  const settings = useHydratedSettings();
  const t = useTheme();

  const headerHeight = useHeaderHeight();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [pendingTurns, setPendingTurns] = useState(0);
  const [draft, setDraft] = useState('');
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [changedFiles, setChangedFiles] = useState<Map<string, 'add' | 'change' | 'unlink'>>(new Map());
  const [filesPaneOpen, setFilesPaneOpen] = useState(false);
  const [sessionLabel, setSessionLabel] = useState<string | null>(null);
  const [sessionProject, setSessionProject] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<UploadResult[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [olderCursor, setOlderCursor] = useState<{ before: string | null; hasMore: boolean }>({
    before: null,
    hasMore: false,
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Which page of the pager is visible. When the preview page is active we
  // suppress the navigator's back-swipe, otherwise iOS' edge gesture captures
  // a right-swipe and pops to /sessions instead of returning to chat.
  const [pagerIndex, setPagerIndex] = useState(0);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const sending = pendingTurns > 0;
  const stickToBottomRef = useRef(true);
  // Only believe onScroll's "user moved up" verdict after the user has actually
  // touched the list. Otherwise the initial layout pass (scroll at top while
  // content is much taller than the viewport) gets misread as a manual scroll
  // and disables auto-stick before the first message ever renders.
  const userScrolledRef = useRef(false);

  const sendRef = useRef<((m: any) => void) | null>(null);
  const replayDoneRef = useRef(false);
  // Background bash tracking. Two maps:
  //   pendingBashRef: toolUseId of a Bash(run_in_background=true) → true, until
  //     we see its tool_result and learn the shell id.
  //   shellMapRef:    shell id (e.g. "bash_1") → original Bash toolUseId.
  // Used so a BashOutput / KillShell tool_use that references that shell can be
  // visually grouped under the original Bash card via parentToolUseId.
  const pendingBashRef = useRef<Map<string, true>>(new Map());
  const shellMapRef = useRef<Map<string, string>>(new Map());
  // toolUseId → tool name. Lets us decide whether a tool_result is informative
  // (Bash output) or noise (e.g. "File read successfully") and should be hidden.
  const toolNamesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    replayDoneRef.current = false;
    pendingBashRef.current = new Map();
    shellMapRef.current = new Map();
    toolNamesRef.current = new Map();
  }, [agent, id]);

  // Pull session metadata (label, project name) for the header title.
  useEffect(() => {
    if (!settings.baseUrl || !agent || !id) return;
    let cancelled = false;
    fetchSessionInfo({ baseUrl: settings.baseUrl, token: settings.token }, agent, id)
      .then((info) => {
        if (cancelled) return;
        setSessionLabel(info.label ?? null);
        setSessionProject(info.projectName ?? null);
      })
      .catch(() => {
        // non-fatal; header just falls back to a generic title
      });
    return () => {
      cancelled = true;
    };
  }, [settings.baseUrl, settings.token, agent, id]);

  const onRename = useCallback(() => {
    Alert.prompt(
      'Rename session',
      'Give this session a name. Leave blank to clear.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: async (text?: string) => {
            const next = (text ?? '').trim();
            try {
              const res = await renameSession(
                { baseUrl: settings.baseUrl, token: settings.token },
                agent,
                id,
                next === '' ? null : next,
              );
              setSessionLabel(res.meta.label ?? null);
            } catch (err) {
              Alert.alert('Rename failed', String((err as Error).message ?? err));
            }
          },
        },
      ],
      'plain-text',
      sessionLabel ?? '',
    );
  }, [settings.baseUrl, settings.token, agent, id, sessionLabel]);

  // Inspect a chat item before it's added; for BashOutput/KillShell, override
  // parentToolUseId with the original background-Bash's toolUseId so indenting
  // groups them visually. For background Bash itself, mark it as pending so we
  // can capture its shell id from the upcoming tool_result.
  function linkBackgroundShell(item: ChatItem): ChatItem {
    if (item.kind !== 'tool_use') return item;
    if (item.name === 'Bash' && (item.input as any)?.run_in_background) {
      pendingBashRef.current.set(item.toolUseId, true);
      return item;
    }
    if (item.name === 'BashOutput' || item.name === 'KillShell' || item.name === 'KillBash') {
      const shellId = readBashId(item.input);
      if (shellId) {
        const parent = shellMapRef.current.get(shellId);
        if (parent && !item.parentToolUseId) {
          return { ...item, parentToolUseId: parent };
        }
      }
    }
    return item;
  }

  // When a tool_result arrives, if we were waiting on a background Bash with
  // this id, parse the shell id out of the result content and record the link.
  function recordBackgroundShell(item: ChatItem): void {
    if (item.kind !== 'tool_result') return;
    if (!pendingBashRef.current.has(item.toolUseId)) return;
    const shellId = extractShellId(item.content);
    if (shellId) shellMapRef.current.set(shellId, item.toolUseId);
    pendingBashRef.current.delete(item.toolUseId);
  }

  function recordToolName(item: ChatItem): void {
    if (item.kind === 'tool_use') toolNamesRef.current.set(item.toolUseId, item.name);
  }

  // True when we should drop a tool_result from the chat (success result for a
  // tool whose output adds no signal beyond the request itself).
  function isQuietResult(item: ChatItem): boolean {
    if (item.kind !== 'tool_result') return false;
    if (item.isError) return false;
    const name = toolNamesRef.current.get(item.toolUseId);
    return name ? QUIET_RESULT_TOOLS.has(name) : false;
  }

  useEffect(() => {
    if (!settings.baseUrl || !agent || !id) return;
    let historyIndex = 0;
    let oldestHistoryTimestamp: string | null = null;
    let historyCount = 0;
    let liveAssistantBuffer: { id: string; text: string } | null = null;

    const handle = openStream(
      { baseUrl: settings.baseUrl, token: settings.token },
      agent,
      id,
      {
        onStateChange: (state) => setConnState(state),
        onMessage: (msg) => {
          switch (msg.type) {
            case 'history_replay_start':
              setItems([]);
              historyIndex = 0;
              historyCount = 0;
              oldestHistoryTimestamp = null;
              break;
            case 'history_entry': {
              historyCount += 1;
              if (oldestHistoryTimestamp === null && msg.entry.kind !== 'system') {
                oldestHistoryTimestamp = msg.entry.timestamp;
              }
              const item = entryToChatItem(msg.entry, historyIndex++);
              if (item) {
                recordToolName(item);
                const linked = linkBackgroundShell(item);
                recordBackgroundShell(linked);
                if (isQuietResult(linked)) break;
                setItems((prev) => [...prev, linked]);
              }
              break;
            }
            case 'history_replay_end':
              setOlderCursor({
                before: oldestHistoryTimestamp,
                hasMore: historyCount >= 50,
              });
              replayDoneRef.current = true;
              // After all history rows have been appended, force scroll to the
              // latest message. Retry a few times: the first call lands before
              // layout has settled the new content height; the later ones catch
              // the final stable height. cheap, and only runs once per open.
              stickToBottomRef.current = true;
              listRef.current?.scrollToEnd({ animated: false });
              requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
              setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
              setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 200);
              break;
            case 'status':
              setStatus(msg.status);
              break;
            case 'session_busy':
              setItems((prev) => {
                const filtered = prev.filter((it) => it.kind !== 'takeover_prompt');
                const lastUser = [...filtered].reverse().find((it) => it.kind === 'user');
                const pending = lastUser?.kind === 'user' ? lastUser.text : '';
                return [
                  ...filtered,
                  {
                    id: `takeover-${Date.now()}`,
                    kind: 'takeover_prompt',
                    pids: msg.pids,
                    pendingMessage: pending,
                  },
                ];
              });
              setPendingTurns((n) => Math.max(0, n - 1));
              break;
            case 'event':
              handleLiveEvent(msg.event);
              break;
            case 'error':
              setItems((prev) => [
                ...prev,
                { id: `meta-${Date.now()}`, kind: 'meta', text: `Error: ${msg.message}` },
              ]);
              setPendingTurns((n) => Math.max(0, n - 1));
              break;
            case 'file_changed':
              setChangedFiles((prev) => {
                const next = new Map(prev);
                if (msg.op === 'unlink') next.set(msg.path, 'unlink');
                else next.set(msg.path, msg.op);
                return next;
              });
              break;
            case 'process_exit':
              setPendingTurns((n) => Math.max(0, n - 1));
              setStatus('idle');
              break;
          }
        },
      },
    );
    sendRef.current = (m) => handle.send(m);

    function handleLiveEvent(ev: AgentEvent) {
      switch (ev.type) {
        case 'text':
          if (ev.role === 'user') return;
          if (liveAssistantBuffer) {
            const buf = liveAssistantBuffer;
            // If the finalized text is empty, keep what deltas already produced
            // and just mark the bubble non-live. Otherwise replace with the
            // canonical final text.
            const finalText = ev.text.trim() ? ev.text : buf.text;
            setItems((prev) =>
              prev.map((it) =>
                it.id === buf.id && it.kind === 'assistant'
                  ? { ...it, text: finalText, live: false, parentToolUseId: ev.parentToolUseId }
                  : it,
              ),
            );
            liveAssistantBuffer = null;
          } else {
            // Drop empty assistant text blocks (e.g. turns that are just a
            // tool_use); rendering them creates a blank bubble. Replay path
            // already filters these the same way.
            if (!ev.text.trim()) return;
            const newId = `live-a-${ev.messageId ?? Date.now()}-${Math.random()}`;
            setItems((prev) => [
              ...prev,
              {
                id: newId,
                kind: 'assistant',
                text: ev.text,
                live: true,
                parentToolUseId: ev.parentToolUseId,
              },
            ]);
          }
          break;
        case 'text_delta':
          if (liveAssistantBuffer) {
            liveAssistantBuffer.text += ev.delta;
            const buf = liveAssistantBuffer;
            setItems((prev) =>
              prev.map((it) =>
                it.id === buf.id && it.kind === 'assistant' ? { ...it, text: buf.text } : it,
              ),
            );
          } else {
            // Avoid seeding a buffer (and bubble) from an empty leading delta.
            if (!ev.delta) return;
            const newId = `live-d-${Date.now()}-${Math.random()}`;
            liveAssistantBuffer = { id: newId, text: ev.delta };
            setItems((prev) => [
              ...prev,
              {
                id: newId,
                kind: 'assistant',
                text: ev.delta,
                live: true,
                parentToolUseId: ev.parentToolUseId,
              },
            ]);
          }
          break;
        case 'tool_use': {
          liveAssistantBuffer = null;
          const tu = linkBackgroundShell({
            id: `live-tu-${ev.toolUseId}`,
            kind: 'tool_use',
            name: ev.name,
            toolUseId: ev.toolUseId,
            input: ev.input,
            running: true,
            live: true,
            parentToolUseId: ev.parentToolUseId,
          });
          recordToolName(tu);
          setItems((prev) => [...prev, tu]);
          break;
        }
        case 'tool_result': {
          const trItem: ChatItem = {
            id: `live-tr-${ev.toolUseId}-${Date.now()}`,
            kind: 'tool_result',
            toolUseId: ev.toolUseId,
            content: ev.content,
            isError: ev.isError,
            live: true,
            parentToolUseId: ev.parentToolUseId,
          };
          recordBackgroundShell(trItem);
          // Mark the matching tool_use as "done" regardless; only the visible
          // result card is suppressed for quiet tools.
          const quiet = isQuietResult(trItem);
          setItems((prev) => {
            const updated = prev.map((it) =>
              it.kind === 'tool_use' && it.toolUseId === ev.toolUseId
                ? { ...it, running: false }
                : it,
            );
            return quiet ? updated : [...updated, trItem];
          });
          break;
        }
        case 'permission_request':
          setApproval({ toolUseId: ev.toolUseId, tool: ev.tool, input: ev.input });
          break;
        case 'result':
          setPendingTurns((n) => Math.max(0, n - 1));
          if (ev.subtype && ev.subtype !== 'success') {
            setItems((prev) => [
              ...prev,
              {
                id: `meta-${Date.now()}`,
                kind: 'meta',
                text: ev.subtype === 'error_during_execution' ? 'Stopped.' : `Result: ${ev.subtype}`,
              },
            ]);
          }
          liveAssistantBuffer = null;
          break;
        case 'thinking':
        case 'raw':
          break;
      }
    }

    return () => {
      handle.close();
      sendRef.current = null;
    };
  }, [settings.baseUrl, settings.token, agent, id]);

  function onSend() {
    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;
    if (!sendRef.current) return;
    // Prepend attachment references so Claude reads them with the Read tool
    // (which natively handles images as content blocks).
    const attachLines = attachments
      .map((a) => `[Attached ${a.isImage ? 'image' : 'file'}: ${a.rel}]`)
      .join('\n');
    const composed = attachLines ? `${attachLines}\n\n${userText}`.trim() : userText;
    if (!composed) return;

    setPendingTurns((n) => n + 1);
    setItems((prev) => [
      ...prev,
      { id: `local-u-${Date.now()}`, kind: 'user', text: composed, live: true },
    ]);
    stickToBottomRef.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    try {
      sendRef.current({ type: 'user_message', content: composed });
      setDraft('');
      setAttachments([]);
    } catch (err) {
      setPendingTurns((n) => Math.max(0, n - 1));
      setItems((prev) => [
        ...prev,
        { id: `meta-${Date.now()}`, kind: 'meta', text: `Send failed: ${String((err as Error).message)}` },
      ]);
    }
  }

  async function runUpload(kind: 'image' | 'photo' | 'document') {
    setAttachMenuOpen(false);
    if (uploading) return;
    setUploading(true);
    try {
      const cfg = { baseUrl: settings.baseUrl, token: settings.token };
      const result =
        kind === 'image'
          ? await pickAndUploadImage(cfg, agent, id)
          : kind === 'photo'
            ? await captureAndUploadPhoto(cfg, agent, id)
            : await pickAndUploadDocument(cfg, agent, id);
      if (result) {
        setAttachments((prev) => [...prev, result]);
      }
    } catch (err) {
      Alert.alert('Upload failed', String((err as Error).message ?? err));
    } finally {
      setUploading(false);
    }
  }

  function onInterrupt() {
    sendRef.current?.({ type: 'interrupt' });
  }

  async function onLoadOlder() {
    if (loadingOlder || !olderCursor.hasMore || !olderCursor.before) return;
    setLoadingOlder(true);
    const wasStuck = stickToBottomRef.current;
    stickToBottomRef.current = false;
    try {
      const page = await fetchHistory(
        { baseUrl: settings.baseUrl, token: settings.token },
        agent,
        id,
        { before: olderCursor.before, limit: 50 },
      );
      if (page.entries.length === 0) {
        setOlderCursor((c) => ({ ...c, hasMore: false }));
        return;
      }
      const olderItems: ChatItem[] = [];
      // page.entries are oldest-first; process in that order so the shell-map
      // and tool-name map see each tool_use before its result.
      page.entries.forEach((e, i) => {
        const item = entryToChatItem(e, -1 - i - Date.now());
        if (!item) return;
        recordToolName(item);
        const linked = linkBackgroundShell(item);
        recordBackgroundShell(linked);
        if (isQuietResult(linked)) return;
        olderItems.push(linked);
      });
      setItems((prev) => [...olderItems, ...prev]);
      setOlderCursor({
        before: page.cursor.before ?? olderCursor.before,
        hasMore: page.cursor.hasMore,
      });
    } catch (err) {
      setItems((prev) => [
        ...prev,
        {
          id: `meta-${Date.now()}`,
          kind: 'meta',
          text: `Couldn't load older: ${String((err as Error).message)}`,
        },
      ]);
    } finally {
      setLoadingOlder(false);
      setTimeout(() => {
        stickToBottomRef.current = wasStuck;
      }, 120);
    }
  }

  const onTakeover = useCallback(
    async function onTakeover(pendingMessage: string) {
      setItems((prev) => [
        ...prev.filter((it) => it.kind !== 'takeover_prompt'),
        { id: `meta-${Date.now()}`, kind: 'meta', text: 'Taking ownership…' },
      ]);
      try {
        const result = await takeOwnership(
          { baseUrl: settings.baseUrl, token: settings.token },
          agent,
          id,
        );
        setItems((prev) => [
          ...prev,
          {
            id: `meta-${Date.now()}`,
            kind: 'meta',
            text: result.force
              ? `Force-killed pid${result.killed.length > 1 ? 's' : ''} ${result.killed.join(', ')} — resuming here.`
              : `Closed desktop claude (pid${result.killed.length > 1 ? 's' : ''} ${result.killed.join(', ')}) — resuming here.`,
          },
        ]);
        if (pendingMessage && sendRef.current) {
          setPendingTurns((n) => n + 1);
          sendRef.current({ type: 'user_message', content: pendingMessage });
        }
      } catch (err) {
        setItems((prev) => [
          ...prev,
          {
            id: `meta-${Date.now()}`,
            kind: 'meta',
            text: `Takeover failed: ${String((err as Error).message)}`,
          },
        ]);
      }
    },
    [settings.baseUrl, settings.token, agent, id],
  );

  function onApprovalDecision(decision: 'allow' | 'allow_always' | 'deny') {
    if (!approval || !sendRef.current) {
      setApproval(null);
      return;
    }
    try {
      sendRef.current({ type: 'approval', toolUseId: approval.toolUseId, decision });
    } catch (err) {
      setItems((prev) => [
        ...prev,
        {
          id: `meta-${Date.now()}`,
          kind: 'meta',
          text: `Approval send failed: ${String((err as Error).message)}`,
        },
      ]);
    }
    setApproval(null);
  }

  const statusLabel = useMemo(() => {
    if (connState === 'connecting') return 'connecting';
    if (connState === 'closed' || connState === 'error') return 'disconnected';
    return status === 'live-bridge' ? 'live · phone' : status === 'live-desktop' ? 'live · desktop' : 'idle';
  }, [connState, status]);

  if (!settings.hydrated || !settings.baseUrl) {
    return (
      <View style={[styles.centered, { backgroundColor: t.surface.base }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const chatBody = (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
      style={{ flex: 1, backgroundColor: t.surface.base }}>
      <Stack.Screen
        options={{
          title: sessionLabel ?? sessionProject ?? 'Chat',
          gestureEnabled: pagerIndex === 0,
          headerTitle: () => (
            <Pressable onPress={onRename} hitSlop={8} style={{ alignItems: 'center' }}>
              <Text
                numberOfLines={1}
                style={{ color: t.text.primary, fontSize: fontSize.lg, fontWeight: '600' }}>
                {sessionLabel ?? sessionProject ?? 'Chat'}
              </Text>
              {sessionLabel && sessionProject && sessionLabel !== sessionProject ? (
                <Text style={{ color: t.text.muted, fontSize: fontSize.xs }} numberOfLines={1}>
                  {sessionProject}
                </Text>
              ) : null}
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/sessions/${agent}/${id}/diff`)}
              hitSlop={8}
              style={{ paddingHorizontal: 4 }}>
              <Text style={{ color: t.accent.primary, fontSize: fontSize.lg, fontWeight: '600' }}>
                {changedFiles.size > 0 ? `Diff (${changedFiles.size})` : 'Diff'}
              </Text>
            </Pressable>
          ),
        }}
      />
      <View style={[styles.statusBar, { borderBottomColor: t.border.subtle }]}>
        <Text style={[styles.statusBarText, { color: t.text.secondary }]} numberOfLines={1}>
          {statusLabel} · {agent} · {id.slice(0, 8)} · {items.length}
        </Text>
      </View>
      {changedFiles.size > 0 ? (
        <View style={[styles.filesPane, { borderBottomColor: t.border.subtle }]}>
          <Pressable onPress={() => setFilesPaneOpen((o) => !o)} style={styles.filesPaneHeader}>
            <Text style={[styles.filesPaneLabel, { color: t.text.primary }]}>
              📂 {changedFiles.size} file{changedFiles.size === 1 ? '' : 's'} changed
            </Text>
            <Pressable onPress={() => router.push(`/sessions/${agent}/${id}/diff`)} hitSlop={8}>
              <Text style={[styles.filesPaneAction, { color: t.accent.primary }]}>View diff</Text>
            </Pressable>
            <Text style={[styles.filesPaneToggle, { color: t.text.secondary }]}>
              {filesPaneOpen ? '▲' : '▼'}
            </Text>
          </Pressable>
          {filesPaneOpen ? (
            <View style={styles.filesList}>
              {Array.from(changedFiles.entries()).map(([path, op]) => {
                const o = opStyle(op, t);
                return (
                  <Pressable
                    key={path}
                    onPress={() => router.push(`/sessions/${agent}/${id}/file?path=${encodeURIComponent(path)}`)}
                    style={styles.fileRow}>
                    <Text style={[styles.fileOp, { color: o.color }]}>{o.symbol}</Text>
                    <Text style={[styles.filePath, { color: t.text.primary }]} numberOfLines={1}>
                      {path}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{
          paddingVertical: space[2],
          paddingHorizontal: space[3],
          gap: space[2] + 2,
          flexGrow: 1,
          justifyContent: 'flex-end',
        }}
        renderItem={({ item }) => {
          const indented = 'parentToolUseId' in item && Boolean(item.parentToolUseId);
          return (
            <View
              style={
                indented
                  ? [styles.subAgentIndent, { borderLeftColor: t.border.default }]
                  : undefined
              }>
              {indented ? (
                <Text style={[styles.subAgentTag, { color: t.text.muted, borderColor: t.border.subtle }]}>
                  ↳ sub-agent
                </Text>
              ) : null}
              <ChatRow item={item} onTakeover={onTakeover} />
            </View>
          );
        }}
        initialNumToRender={30}
        maxToRenderPerBatch={20}
        windowSize={9}
        ListHeaderComponent={
          loadingOlder ? (
            <View style={styles.loadingOlderRow}>
              <ActivityIndicator size="small" color={t.text.secondary} />
              <Text style={[styles.thinkingText, { color: t.text.secondary }]}>
                Loading earlier messages…
              </Text>
            </View>
          ) : olderCursor.hasMore ? (
            <Pressable
              onPress={onLoadOlder}
              style={[styles.loadOlderRow, { backgroundColor: t.surface.raised }]}>
              <Text style={[styles.loadOlderText, { color: t.accent.primary }]}>Load earlier messages</Text>
            </Pressable>
          ) : items.length > 0 ? (
            <View style={styles.beginningRow}>
              <Text style={[styles.thinkingText, { color: t.text.muted }]}>Beginning of conversation</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          sending ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator size="small" color={t.text.secondary} />
              <Text style={[styles.thinkingText, { color: t.text.secondary }]}>Claude is thinking…</Text>
            </View>
          ) : null
        }
        onScrollBeginDrag={() => {
          userScrolledRef.current = true;
        }}
        onScroll={(e) => {
          if (!userScrolledRef.current) return;
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          stickToBottomRef.current = fromBottom < 80;
        }}
        scrollEventThrottle={120}
        onContentSizeChange={() => {
          if (stickToBottomRef.current) {
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
      />
      {draft.startsWith('/') ? <SlashPicker draft={draft} onPick={(cmd) => setDraft(cmd + ' ')} /> : null}
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          style={[styles.attachBar, { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken }]}
          contentContainerStyle={{ gap: space[2], paddingHorizontal: space[2] + 2, alignItems: 'center' }}>
          {attachments.map((a, i) => (
            <View key={`${a.rel}-${i}`} style={[styles.attachChip, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
              <Text style={{ fontSize: fontSize.sm }}>{a.isImage ? '🖼' : '📎'}</Text>
              <Text style={{ color: t.text.primary, fontSize: fontSize.sm, maxWidth: 180 }} numberOfLines={1}>
                {a.rel.split('/').pop()}
              </Text>
              <Pressable onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} hitSlop={6}>
                <Text style={{ color: t.text.muted, fontSize: fontSize.md }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      {attachMenuOpen ? (
        <View style={[styles.attachMenu, { backgroundColor: t.surface.sunken, borderTopColor: t.border.subtle }]}>
          <Pressable
            onPress={() => runUpload('image')}
            style={({ pressed }) => [
              styles.attachOption,
              { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
            ]}>
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>🖼  Photo library</Text>
          </Pressable>
          <Pressable
            onPress={() => runUpload('photo')}
            style={({ pressed }) => [
              styles.attachOption,
              { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
            ]}>
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>📷  Take photo</Text>
          </Pressable>
          <Pressable
            onPress={() => runUpload('document')}
            style={({ pressed }) => [
              styles.attachOption,
              { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
            ]}>
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>📄  File</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.inputRow, { borderTopColor: t.border.subtle }]}>
        <Pressable
          onPress={() => setAttachMenuOpen((o) => !o)}
          disabled={uploading}
          hitSlop={6}
          style={[
            styles.attachButton,
            { backgroundColor: attachMenuOpen ? t.surface.pressed : t.surface.raised },
          ]}>
          {uploading ? (
            <ActivityIndicator size="small" color={t.text.secondary} />
          ) : (
            <Text style={[styles.attachIcon, { color: t.text.primary }]}>＋</Text>
          )}
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder={sending ? 'Queue your next message…' : 'Message your agent'}
          placeholderTextColor={t.text.placeholder}
          style={[
            styles.input,
            { color: t.text.primary, backgroundColor: t.surface.raised },
          ]}
        />
        {sending ? (
          <Pressable
            onPress={onInterrupt}
            style={[styles.iconButton, { backgroundColor: t.status.danger }]}
            hitSlop={8}>
            <Text style={[styles.iconButtonLabel, { color: t.text.inverse }]}>■</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onSend}
          disabled={!draft.trim()}
          style={[
            styles.sendButton,
            { backgroundColor: draft.trim() ? t.accent.primary : t.surface.pressed },
          ]}>
          <Text style={[styles.sendLabel, { color: draft.trim() ? t.accent.fg : t.text.muted }]}>Send</Text>
        </Pressable>
      </View>
      <ApprovalSheet approval={approval} onDecision={onApprovalDecision} />
    </KeyboardAvoidingView>
  );

  return (
    <ChatPreviewPager
      chat={chatBody}
      preview={(active) => <PreviewPane agent={agent} id={id} active={active} />}
      onIndexChange={setPagerIndex}
    />
  );
}

function SlashPicker({ draft, onPick }: { draft: string; onPick: (cmd: string) => void }) {
  const t = useTheme();
  const q = draft.trim().toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  if (matches.length === 0) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[
        styles.slashRow,
        { backgroundColor: t.surface.sunken, borderTopColor: t.border.subtle },
      ]}
      contentContainerStyle={{ paddingHorizontal: space[2] + 2, gap: space[2], alignItems: 'center' }}>
      {matches.map((cmd) => (
        <Pressable
          key={cmd.name}
          onPress={() => onPick(cmd.name)}
          style={({ pressed }) => [
            styles.slashChip,
            {
              backgroundColor: pressed ? t.surface.pressed : t.surface.raised,
              borderColor: t.border.subtle,
            },
          ]}>
          <Text style={[styles.slashCmd, { color: t.accent.primary }]}>{cmd.name}</Text>
          <Text style={[styles.slashHint, { color: t.text.secondary }]} numberOfLines={1}>
            {cmd.hint}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const ChatRow = memo(
  function ChatRow({
    item,
    onTakeover,
  }: {
    item: ChatItem;
    onTakeover: (pendingMessage: string) => void;
  }) {
    const t = useTheme();

    if (item.kind === 'user') {
      return (
        <View style={[styles.bubbleUser, { backgroundColor: t.bubble.userBg }]}>
          <Markdown text={item.text} color={t.bubble.userFg} />
        </View>
      );
    }
    if (item.kind === 'assistant') {
      return (
        <View style={[styles.bubbleAssistant, { backgroundColor: t.bubble.assistantBg }]}>
          <Markdown text={item.text} color={t.bubble.assistantFg} />
        </View>
      );
    }
    if (item.kind === 'tool_use') {
      return <ToolUseCard name={item.name} input={item.input} running={item.running} />;
    }
    if (item.kind === 'tool_result') {
      return <ToolResultCard toolUseId={item.toolUseId} content={item.content} isError={item.isError} />;
    }
    if (item.kind === 'meta') {
      return (
        <View style={styles.metaRow}>
          <Text style={[styles.metaText, { color: t.text.secondary }]}>{item.text}</Text>
        </View>
      );
    }
    if (item.kind === 'takeover_prompt') {
      return (
        <View
          style={[
            styles.takeoverCard,
            { backgroundColor: t.status.warningCardBg, borderColor: t.status.warning },
          ]}>
          <Text style={[styles.takeoverTitle, { color: t.status.warningCardFg }]}>
            Session active on desktop
          </Text>
          <Text style={[styles.takeoverBody, { color: t.status.warningCardFg }]}>
            A claude is running on your laptop (pid {item.pids.join(', ')}). Take ownership to close
            it and run your message here instead.
          </Text>
          <Pressable
            onPress={() => onTakeover(item.pendingMessage)}
            style={({ pressed }) => [
              styles.takeoverButton,
              { backgroundColor: pressed ? t.accent.pressed : t.status.warning },
            ]}>
            <Text style={[styles.takeoverButtonLabel, { color: t.text.inverse }]}>Take ownership</Text>
          </Pressable>
        </View>
      );
    }
    return null;
  },
  (prev, next) => {
    if (prev.onTakeover !== next.onTakeover) return false;
    if (prev.item.id !== next.item.id) return false;
    if (prev.item.kind !== next.item.kind) return false;
    if (prev.item.kind === 'assistant' && next.item.kind === 'assistant') {
      return prev.item.text === next.item.text;
    }
    if (prev.item.kind === 'tool_use' && next.item.kind === 'tool_use') {
      return prev.item.running === next.item.running;
    }
    return true;
  },
);

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  statusBar: {
    paddingVertical: space[1.5],
    paddingHorizontal: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusBarText: { fontSize: fontSize.sm },
  bubbleUser: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius['2xl'] - 2,
    borderBottomRightRadius: radius.sm,
  },
  bubbleAssistant: {
    alignSelf: 'flex-start',
    maxWidth: '94%',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius['2xl'] - 2,
    borderBottomLeftRadius: radius.sm,
  },
  metaRow: { alignSelf: 'center', paddingHorizontal: space[2] + 2, paddingVertical: 4 },
  metaText: { fontSize: fontSize.sm, textAlign: 'center' },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
    alignSelf: 'flex-start',
  },
  thinkingText: { fontSize: fontSize.base, fontStyle: 'italic' },
  loadOlderRow: {
    alignSelf: 'center',
    paddingHorizontal: space[3] + 2,
    paddingVertical: space[2],
    borderRadius: radius['2xl'] - 2,
    marginBottom: space[2],
    minWidth: 180,
    alignItems: 'center',
  },
  loadOlderText: { fontSize: fontSize.base, fontWeight: '600' },
  loadingOlderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingVertical: space[2] + 2,
  },
  beginningRow: { alignItems: 'center', paddingVertical: space[3] },
  takeoverCard: {
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space[3] + 2,
    paddingVertical: space[3],
    gap: space[2],
  },
  takeoverTitle: { fontSize: fontSize.md, fontWeight: '700' },
  takeoverBody: { fontSize: fontSize.base, lineHeight: 19 },
  takeoverButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[3] + 2,
    paddingVertical: space[2],
    borderRadius: radius.lg,
    marginTop: 4,
  },
  takeoverButtonLabel: { fontSize: fontSize.base, fontWeight: '600' },
  filesPane: { borderBottomWidth: StyleSheet.hairlineWidth },
  filesPaneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 10,
  },
  filesPaneLabel: { flex: 1, fontSize: fontSize.base, fontWeight: '600' },
  filesPaneAction: { fontSize: fontSize.base, fontWeight: '600' },
  filesPaneToggle: { fontSize: fontSize.sm },
  filesList: { paddingHorizontal: space[3], paddingBottom: space[2], gap: 4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: 4 },
  fileOp: {
    width: 16,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: fontFamily.mono,
  },
  filePath: { flex: 1, fontSize: fontSize.base, fontFamily: fontFamily.mono },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: space[2],
    gap: space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    borderRadius: radius['2xl'] + 2,
    paddingHorizontal: space[3] + 2,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: fontSize.lg,
  },
  sendButton: {
    paddingHorizontal: space[3] + 2,
    paddingVertical: 10,
    borderRadius: radius['2xl'] + 2,
    justifyContent: 'center',
  },
  sendLabel: { fontWeight: '600', fontSize: fontSize.md },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  iconButtonLabel: { fontSize: fontSize.xl, fontWeight: '700', textAlign: 'center' },
  slashRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: space[1.5], maxHeight: 56 },
  slashChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space[2],
    paddingHorizontal: space[2] + 2,
    paddingVertical: space[1.5],
    borderRadius: radius['2xl'] - 2,
    borderWidth: 1,
    maxWidth: 280,
  },
  slashCmd: { fontSize: fontSize.base, fontWeight: '600', fontFamily: fontFamily.mono },
  slashHint: { fontSize: fontSize.sm, flexShrink: 1 },
  subAgentIndent: {
    marginLeft: space[3] + 2,
    paddingLeft: space[2] + 2,
    borderLeftWidth: 2,
    gap: 4,
  },
  subAgentTag: {
    alignSelf: 'flex-start',
    fontSize: fontSize.xs - 1,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: space[1.5],
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: radius.sm,
    marginBottom: 4,
  },
  attachBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space[1.5],
    maxHeight: 56,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1.5],
    paddingHorizontal: space[2] + 2,
    paddingVertical: space[1.5],
    borderRadius: radius['2xl'] - 2,
    borderWidth: 1,
  },
  attachMenu: {
    flexDirection: 'row',
    gap: space[2],
    padding: space[2] + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachOption: {
    flex: 1,
    paddingVertical: space[2] + 2,
    paddingHorizontal: space[2],
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
  },
  attachLabel: { fontSize: fontSize.base, fontWeight: '500' },
  attachButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  attachIcon: { fontSize: fontSize.xl, fontWeight: '700', lineHeight: 22 },
});
