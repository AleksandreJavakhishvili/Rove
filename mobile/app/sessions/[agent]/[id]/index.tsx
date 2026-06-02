import { ApprovalSheet, type PendingApproval } from '@/components/chat/ApprovalSheet';
import { CrossSessionApprovals } from '@/components/chat/crossSession/CrossSessionApprovals';
import {
  BubbleActionMenu,
  copyAction,
  forkAction,
  rewindAction,
  triggerOpenHaptic,
  type BubbleAction,
  type BubbleMenuAnchor,
} from '@/components/chat/BubbleActionMenu';
import { PressableBubble } from '@/components/chat/PressableBubble';
import {
  ChatPreviewPager,
  type ChatPreviewPagerHandle,
} from '@/components/chat/ChatPreviewPager';
import type { GestureType } from 'react-native-gesture-handler';
import { PreviewShutter, ShutterFlash } from '@/components/PreviewShutter';
import { ScreenshotComposer } from '@/components/ScreenshotComposer';
import { useScreenshotCapture } from '@/hooks/useScreenshotCapture';
import { Markdown } from '@/components/chat/Markdown';
import { MentionPicker } from '@/components/chat/MentionPicker';
import { PreviewPane } from '@/components/chat/PreviewPane';
import { ToolResultCard, ToolUseCard } from '@/components/chat/ToolCard';
import { FilesPane } from '@/components/files/FilesPane';
import { SessionsSidebar } from '@/components/SessionsSidebar';
import {
  TakeoverController,
  type TakeoverFrameHandler,
} from '@/components/takeover/TakeoverController';
import { isVisualFeedbackTool } from '@/components/takeover/toolLabels';
import { WorkspacePane, type WorkspacePaneHandle } from '@/components/WorkspacePane';
import type { PreviewFrameHandle } from '@/components/chat/PreviewFrame';
import {
  fetchHistory,
  fetchSessionInfo,
  forkSession,
  openStream,
  renameSession,
  sendApproval,
  takeOwnership,
  type ConnectionState,
} from '@/lib/bridge';
import {
  clearInlineDiffCacheForSession,
  invalidateInlineDiffsForPath,
} from '@/lib/diffCache';
import {
  useHydratedSettings,
  useSessionCapabilities,
  useSessionCapabilitiesStore,
} from '@/lib/store';
import { bridgeToConfig, useActiveBridge, useBridge } from '@/lib/bridges';
import {
  captureAndUploadPhoto,
  pickAndUploadDocument,
  pickAndUploadImage,
  type UploadResult,
} from '@/lib/uploads';
import {
  COMPACT_TRIGGER,
  HANDOFF_RESULT_STATUS,
  SCREENSHOT_ERROR_REASON,
  SDK_RUN_STATUS,
  type AgentEvent,
  type HistoryEntry,
  type PermissionMode,
  type SdkRunStatus,
  type SessionStatus,
  type WorkflowTaskStatus,
} from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from '@react-navigation/elements';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  FlatList,
  Image,
  Keyboard,
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

// Friendly hints for SDK-advertised commands. Anything not listed (e.g. a
// saved workflow) still shows with a generic hint so it's pickable.
const SLASH_HINTS: Record<string, string> = {
  compact: 'Summarize older turns to free context',
  cost: 'Show token usage and spend',
  model: 'Switch model',
  help: 'List available commands',
  agents: 'Manage agents',
  mcp: 'Manage MCP servers',
  clear: 'Reset conversation context',
  init: 'Initialize a CLAUDE.md for the project',
  workflow: 'Run a saved workflow',
  workflows: 'Inspect live & completed workflow runs',
};

/** Build the slash-command list. When the bridge supplies the SDK's command
 *  list (incl. /workflow + saved workflows) use it; otherwise fall back to the
 *  built-in set so older bridges still get a picker. */
function buildSlashCommands(supported?: string[]): SlashCmd[] {
  if (!supported || supported.length === 0) return SLASH_COMMANDS;
  return supported.map((raw) => {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    return { name: `/${name}`, hint: SLASH_HINTS[name] ?? 'Slash command' };
  });
}

type ChatItem =
  | { id: string; kind: 'user'; text: string; live?: boolean; parentToolUseId?: string; messageId?: string }
  | { id: string; kind: 'assistant'; text: string; live?: boolean; parentToolUseId?: string; messageId?: string }
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
  | {
      id: string;
      kind: 'workflow';
      taskId: string;
      workflowName?: string;
      status?: WorkflowTaskStatus;
      description?: string;
      summary?: string;
    }
  | { id: string; kind: 'takeover_prompt'; pids: number[]; pendingMessage: string };

// Claude Code rewrites a user-typed slash command into a synthetic user
// message wrapped in `<command-name>…</command-name><command-message>…
// </command-message><command-args>…</command-args>`, then posts the
// captured stdout back as another user message wrapped in
// `<local-command-stdout>…</local-command-stdout>`. These artifacts live
// in the JSONL transcript but are noise to display verbatim — surface them
// as a small meta pill so the user sees "what happened" without the XML.
// Match anywhere in the text — not anchored — so wrappers that have leading
// whitespace, surrounding blank lines, or unexpected sibling tags still get
// caught. Claude Code's exact serialization has shifted at least once and
// we want this filter to be robust against future small format changes.
const SLASH_CMD_WRAPPER_RE = /<command-name>([^<]+)<\/command-name>/;
const LOCAL_STDOUT_WRAPPER_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
// Claude 4.8 injects a finished background task's result back into the
// conversation as a synthetic user message wrapped in
// `<task-notification>…</task-notification>` (carrying <task-id>, <status>,
// <summary>, <result>). Like the slash-command wrappers above this is noise to
// render verbatim — surface it as a workflow card with status + summary.
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;
function taskField(block: string, tag: string): string {
  return (block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '').trim();
}

// Claude Code records an interrupt (user stopped the turn) as a synthetic
// message whose text is `[Request interrupted by user]` (sometimes with a
// trailing qualifier). Rendering it as a normal user bubble reads like the
// user typed it — surface it as a centered "Interrupted" meta note instead.
const INTERRUPTED_RE = /^\[Request interrupted by user/;

function slashCommandMeta(text: string, id: string): ChatItem | null {
  if (INTERRUPTED_RE.test(text.trim())) {
    return { id, kind: 'meta', text: 'Interrupted' };
  }
  const cmd = text.match(SLASH_CMD_WRAPPER_RE);
  if (cmd) {
    const name = (cmd[1] ?? '').trim();
    if (!name) return null;
    return { id, kind: 'meta', text: `Ran ${name}` };
  }
  const task = text.match(TASK_NOTIFICATION_RE);
  if (task) {
    const block = task[1] ?? '';
    const status = taskField(block, 'status');
    return {
      id,
      kind: 'workflow',
      taskId: taskField(block, 'task-id') || id,
      status: (status as WorkflowTaskStatus) || 'completed',
      summary: taskField(block, 'summary') || undefined,
    };
  }
  const out = text.match(LOCAL_STDOUT_WRAPPER_RE);
  if (out) {
    const body = (out[1] ?? '').trim();
    if (!body) return null;
    return { id, kind: 'meta', text: body };
  }
  return null;
}

function entryToChatItem(e: HistoryEntry, index: number): ChatItem | null {
  switch (e.kind) {
    case 'user': {
      const text = extractText(e.content).trim();
      if (!text) return null;
      const meta = slashCommandMeta(text, `h-${index}-${e.uuid}`);
      if (meta) return meta;
      return {
        id: `h-${index}-${e.uuid}`,
        kind: 'user',
        text,
        parentToolUseId: e.parentToolUseId,
        messageId: stripUuidSuffix(e.uuid),
      };
    }
    case 'assistant': {
      const text = extractText(e.content).trim();
      if (!text) return null;
      return {
        id: `h-${index}-${e.uuid}`,
        kind: 'assistant',
        text,
        parentToolUseId: e.parentToolUseId,
        messageId: stripUuidSuffix(e.uuid),
      };
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

/** Bridge replay uuids sometimes have a `:t` (text block) or `:<toolUseId>`
 *  suffix tacked on so multiple entries from one transcript record stay
 *  unique. The rewind API wants the original message uuid, so strip the
 *  first `:` and anything after. */
function stripUuidSuffix(uuid: string): string {
  const colon = uuid.indexOf(':');
  return colon === -1 ? uuid : uuid.slice(0, colon);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
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


function opStyle(op: 'add' | 'change' | 'unlink', t: Theme): { color: string; symbol: string } {
  if (op === 'add') return { color: t.op.add, symbol: 'A' };
  if (op === 'unlink') return { color: t.op.unlink, symbol: 'D' };
  return { color: t.op.change, symbol: 'M' };
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'auto-accept edits',
  plan: 'plan',
  bypassPermissions: 'bypass',
};

function modelDisplay(model: string): string {
  return model.replace(/^claude-/, '');
}

const MODE_DESCRIPTION: Record<PermissionMode, string> = {
  default: 'Prompt on every tool use that isn’t allowlisted.',
  acceptEdits: 'Auto-approve file edits; still prompt for bash and other tools.',
  plan: 'Read-only; Claude proposes a plan instead of acting.',
  bypassPermissions: 'Skip every prompt. Use with care.',
};

export default function ChatScreen() {
  const { agent, id, bridge } = useLocalSearchParams<{
    agent: string;
    id: string;
    bridge?: string;
  }>();
  const settings = useHydratedSettings();
  // Which bridge this chat lives on. Inbox rows navigate with `?bridge=<id>`;
  // links without it (old share URLs) fall back to the active bridge, which is
  // exactly the single-bridge behaviour. `settings` is still used for the
  // visual-feedback prefs; `conn` is the per-bridge connection config.
  const paramBridge = useBridge(typeof bridge === 'string' ? bridge : null);
  const activeBridge = useActiveBridge();
  const connBridge = paramBridge ?? activeBridge;
  const conn = connBridge
    ? bridgeToConfig(connBridge)
    : { baseUrl: '', token: undefined as string | undefined };
  const t = useTheme();
  const capabilities = useSessionCapabilities(agent, id);
  const setCapabilities = useSessionCapabilitiesStore((s) => s.set);
  const clearCapabilities = useSessionCapabilitiesStore((s) => s.clear);

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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  // Mirrors the SDK's `SDKStatus` — `'compacting'` while /compact (or the
  // auto-compact threshold) is running, `'requesting'` while waiting for the
  // model's response, `'idle'` otherwise. Used to swap the chat footer text so
  // the user sees "Compacting context…" instead of the generic "thinking…"
  // line, which makes /compact feel like an action that's actually happening.
  const [sdkStatus, setSdkStatus] = useState<SdkRunStatus>(SDK_RUN_STATUS.idle);
  // Seconds elapsed since compaction started. The SDK exposes no incremental
  // compaction progress (only a binary `compacting` status and the final
  // pre/post token counts on `compact_boundary`), so we surface a live elapsed
  // timer to signal the operation is still running — mirroring the CLI.
  const [compactSeconds, setCompactSeconds] = useState<number>(0);
  // Most recent extended-thinking text from the SDK, shown as a live ticker
  // right above the input row. Cleared as soon as real assistant output (text,
  // text_delta, or tool_use) starts to land, and on result/process_exit. This
  // is the live preview — historical thinking blocks are not (yet) rendered.
  const [thinkingTicker, setThinkingTicker] = useState<string>('');
  // Caret position in `draft`. Tracked via TextInput.onSelectionChange so the
  // @-mention picker knows where the `@<token>` lives. Defaults to end-of-
  // draft so picker-less typing still inserts in the right place.
  const [draftCaret, setDraftCaret] = useState<number>(0);
  // One-shot selection override: when non-null, the TextInput renders with
  // this selection forced (used after the mention picker splices into the
  // draft so the caret lands after the inserted token, not at end-of-text).
  // Cleared as soon as the next selection event fires.
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null);
  // Bumped on every `file_changed` event so the mention picker drops its
  // cached tree on next open. The picker also honors a wall-clock TTL.
  const [mentionRefreshKey, setMentionRefreshKey] = useState<number>(0);
  const inputRef = useRef<TextInput>(null);
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Bumped when the app comes back to the foreground while the chat WS isn't
  // open — triggers the stream effect below to tear down the stale handle and
  // open a fresh one. Without this, the socket stays in 'closed' after the OS
  // kills it during backgrounding and the next user action (approval tap,
  // message send) fails with "stream not open".
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bubbleMenu, setBubbleMenu] = useState<{
    anchor: BubbleMenuAnchor;
    actions: BubbleAction[];
  } | null>(null);
  // Visual-feedback-loop Phase 1: manual screenshot composer state. The
  // capture itself lives on the hook below; this state only governs the
  // sheet visibility + the freshly-uploaded attachment.
  const [shotUpload, setShotUpload] = useState<UploadResult | null>(null);
  const [shotComposerOpen, setShotComposerOpen] = useState(false);
  const [shotFlashNonce, setShotFlashNonce] = useState(0);
  // Per-session "allow autonomous screenshots" toggle. Bridge defaults
  // to true on the server side; we mirror that so the chip in the
  // header menu starts as on. Flipping it pushes a
  // `set_screenshot_allow` frame so the next agent-initiated capture
  // short-circuits to `disabled_by_user` without going to the phone.
  const [allowVisualVerification, setAllowVisualVerification] = useState<boolean>(true);
  // Preview-handoff Phase 2: while a user-direction handoff is active
  // the controller asks us to disable the floating shutter so a manual
  // capture doesn't race the agent's request.
  const [manualShutterLocked, setManualShutterLocked] = useState(false);
  const pagerRef = useRef<ChatPreviewPagerHandle | null>(null);
  // Shared with the cross-session approval badge so it can block this gesture
  // and own horizontal drags that start on it (otherwise the page swipes
  // instead of the badge snapping to the other edge).
  const pagerPanRef = useRef<GestureType | undefined>(undefined);
  const workspaceRef = useRef<WorkspacePaneHandle | null>(null);
  const previewFrameRef = useRef<PreviewFrameHandle | null>(null);
  // Frame handler the TakeoverController registers on mount so the WS
  // message switch can forward `request_screenshot` (and, after the
  // handoff SDD lands, `prepare_preview_request`) into the state
  // machine without the chat screen needing to know how the controller
  // is structured. Initialised to a no-op so a frame arriving before
  // mount is dropped cleanly rather than crashing.
  const takeoverFrameHandler = useRef<TakeoverFrameHandler>(() => false);
  const registerTakeoverFrameHandler = useCallback((handler: TakeoverFrameHandler) => {
    takeoverFrameHandler.current = handler;
  }, []);
  // Capture primitive + ref applied to the PreviewPane's WebView wrapper.
  // `previewFrameRef` lets the hook route iOS captures through the
  // native `WKWebView.takeSnapshot` API (`rove-webview-snapshot`)
  // instead of view-shot's stale-prone host-compositor read.
  const screenshot = useScreenshotCapture(
    conn,
    agent,
    id,
    { previewFrameRef },
  );
  // Preview-takeover Phase 0 — read from a ref so the WS message switch
  // (which doesn't re-subscribe between renders) sees the current value
  // without having to re-open the socket on every settings flip.
  const visualFeedbackEnabledRef = useRef<boolean>(settings.enableVisualFeedback);
  visualFeedbackEnabledRef.current = settings.enableVisualFeedback;
  const connStateRef = useRef<ConnectionState>('connecting');
  connStateRef.current = connState;
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

  // Tick the compaction elapsed timer once per second while `compacting`.
  // Resets to 0 on entry so each compaction counts from its own start, and the
  // interval is torn down the moment status leaves `compacting`.
  useEffect(() => {
    if (sdkStatus !== SDK_RUN_STATUS.compacting) {
      setCompactSeconds(0);
      return;
    }
    setCompactSeconds(0);
    const started = Date.now();
    const handle = setInterval(() => {
      setCompactSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(handle);
  }, [sdkStatus]);

  // Reconnect when the app returns to the foreground with a dead socket. iOS
  // and Android both kill long-lived WebSockets while the app is backgrounded;
  // without this listener the chat stays in 'closed' state and the next user
  // action throws "stream not open".
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const s = connStateRef.current;
      if (s === 'closed' || s === 'error') {
        setReconnectNonce((n) => n + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // Keep the newest messages in view when the keyboard opens. The
  // KeyboardAvoidingView shrinks the list from the bottom as the keyboard
  // animates in, which would otherwise tuck the latest message behind it.
  // Guarded on stickToBottom so someone scrolled up to read older turns isn't
  // yanked down when they tap the input.
  //
  // iOS: `keyboardWillShow` fires as the keyboard *starts* rising, but at that
  // instant the KeyboardAvoidingView hasn't committed its padding yet — the
  // list has no extra room and scrollToEnd is a no-op. Defer one frame so the
  // padding (and thus the new max offset) is in place, while still being early
  // enough in the keyboard animation to move in step with it (no post-anim
  // lag). `keyboardDidShow` is a safety net if that frame lands before layout
  // flushes. Android has no reliable `…WillShow`, so it uses `…DidShow` alone.
  useEffect(() => {
    const toEnd = () => {
      if (!stickToBottomRef.current) return;
      listRef.current?.scrollToEnd({ animated: true });
    };
    const subs = [Keyboard.addListener('keyboardDidShow', toEnd)];
    if (Platform.OS === 'ios') {
      subs.push(Keyboard.addListener('keyboardWillShow', () => requestAnimationFrame(toEnd)));
    }
    return () => subs.forEach((s) => s.remove());
  }, []);

  // Pull session metadata (label, project name) for the header title.
  useEffect(() => {
    if (!conn.baseUrl || !agent || !id) return;
    let cancelled = false;
    fetchSessionInfo(conn, agent, id)
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
  }, [conn.baseUrl, conn.token, agent, id]);

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
                conn,
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
  }, [conn.baseUrl, conn.token, agent, id, sessionLabel]);

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

  // We render only error tool_results — successful ones are dropped because
  // the originating tool_use card already shows what was requested, and the
  // result content is rarely informative for the user.
  function isQuietResult(item: ChatItem): boolean {
    if (item.kind !== 'tool_result') return false;
    return !item.isError;
  }

  useEffect(() => {
    if (!conn.baseUrl || !agent || !id) return;
    let historyIndex = 0;
    let oldestHistoryTimestamp: string | null = null;
    let historyCount = 0;
    let liveAssistantBuffer: { id: string; text: string } | null = null;

    const handle = openStream(
      conn,
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
              // Bridge re-emits the in-flight turn count when we reattach
              // mid-turn (user navigated away and back). Restore pending so
              // the "Thinking…" footer shows immediately instead of waiting
              // for the next event.
              if (typeof msg.pending === 'number' && msg.pending > 0) {
                setPendingTurns((n) => Math.max(n, msg.pending ?? 0));
              }
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
              // Invalidate the mention picker's cached tree — a newly-created
              // file should show up on the next `@` and a deleted one should
              // disappear without a stale TTL window.
              setMentionRefreshKey((n) => n + 1);
              // Invalidate any cached inline diff for the touched path so the
              // next render of an Edit/Write card refetches against the
              // freshly-modified file rather than reading a stale hunk set.
              invalidateInlineDiffsForPath(msg.path);
              break;
            case 'process_exit':
              setPendingTurns((n) => Math.max(0, n - 1));
              setStatus('idle');
              setThinkingTicker('');
              setSdkStatus(SDK_RUN_STATUS.idle);
              break;
            case 'request_screenshot':
              // Visual-feedback-loop Phase 2 — agent asked the bridge to
              // capture the live preview. The takeover controller owns
              // the full flow now (state machine, indicator, pager swap,
              // capture, restore); the chat screen just forwards.
              //
              // Preview-takeover Phase 0: if the global setting is off,
              // drop the frame on the floor and reply `disabled_by_user`
              // immediately — keeps the wire model consistent if the
              // bridge mirror somehow lagged behind.
              if (!visualFeedbackEnabledRef.current) {
                sendRef.current?.({
                  type: 'screenshot_result',
                  requestId: msg.requestId,
                  ok: false,
                  reason: SCREENSHOT_ERROR_REASON.disabled_by_user,
                });
                break;
              }
              takeoverFrameHandler.current(msg);
              break;
            case 'prepare_preview_request':
              // Preview-handoff Phase 1 — agent asked the user to set
              // up the preview. Same Phase 0 gate as above; the
              // controller's reducer owns the rest.
              if (!visualFeedbackEnabledRef.current) {
                sendRef.current?.({
                  type: 'prepare_preview_result',
                  requestId: msg.requestId,
                  status: HANDOFF_RESULT_STATUS.disabled_by_user,
                });
                break;
              }
              takeoverFrameHandler.current(msg);
              break;
          }
        },
      },
    );
    sendRef.current = (m) => handle.send(m);

    function handleLiveEvent(ev: AgentEvent) {
      // Any real output from the model ends the "thinking" phase — drop the
      // live ticker as soon as text, deltas, or tool calls start landing.
      if (
        ev.type === 'text' ||
        ev.type === 'text_delta' ||
        ev.type === 'tool_use' ||
        ev.type === 'result'
      ) {
        setThinkingTicker('');
      }
      switch (ev.type) {
        case 'text':
          if (ev.role === 'user') return;
          if (liveAssistantBuffer) {
            const buf = liveAssistantBuffer;
            // If the finalized text is empty, keep what deltas already produced
            // and just mark the bubble non-live. Otherwise replace with the
            // canonical final text.
            const trimmed = ev.text.trim();
            const finalText = trimmed || buf.text;
            setItems((prev) =>
              prev.map((it) =>
                it.id === buf.id && it.kind === 'assistant'
                  ? {
                      ...it,
                      text: finalText,
                      live: false,
                      parentToolUseId: ev.parentToolUseId,
                      messageId: ev.messageId ?? it.messageId,
                    }
                  : it,
              ),
            );
            liveAssistantBuffer = null;
          } else {
            // Drop empty assistant text blocks (e.g. turns that are just a
            // tool_use); rendering them creates a blank bubble. Replay path
            // already filters these the same way.
            const trimmed = ev.text.trim();
            if (!trimmed) return;
            const newId = `live-a-${ev.messageId ?? Date.now()}-${Math.random()}`;
            setItems((prev) => [
              ...prev,
              {
                id: newId,
                kind: 'assistant',
                text: trimmed,
                live: true,
                parentToolUseId: ev.parentToolUseId,
                messageId: ev.messageId,
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
        case 'permission_mode':
          setPermissionMode(ev.mode);
          break;
        case 'capabilities':
          setCapabilities(agent, id, ev.capabilities);
          break;
        case 'model':
          // Model chip already re-renders off the capabilities snapshot the
          // driver re-emits on every `setModel`. Nothing to do per-event.
          break;
        case 'rewind': {
          // Prune every chat item whose messageId comes at-or-after the
          // rewind target. The bridge already restored the files; surface a
          // meta row so the user knows the action took effect.
          const targetId = ev.messageId;
          setItems((prev) => {
            const cutIdx = prev.findIndex(
              (it) =>
                (it.kind === 'user' || it.kind === 'assistant') && it.messageId === targetId,
            );
            const trimmed = cutIdx === -1 ? prev : prev.slice(0, cutIdx);
            return [
              ...trimmed,
              {
                id: `meta-${Date.now()}`,
                kind: 'meta',
                text:
                  ev.filesAffected.length > 0
                    ? `Rewound — restored ${ev.filesAffected.length} file${ev.filesAffected.length === 1 ? '' : 's'}`
                    : 'Rewound to checkpoint',
              },
            ];
          });
          break;
        }
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
        case 'compact_boundary': {
          // Conversation compaction finished — drop a single meta line so the
          // user can see what just happened. `pre/postTokens` are best-effort;
          // when missing we keep the message simple.
          const trigger = ev.trigger === COMPACT_TRIGGER.auto ? 'Auto-compacted' : 'Compacted';
          const tokens =
            ev.postTokens !== undefined
              ? ` (${formatTokens(ev.preTokens)} → ${formatTokens(ev.postTokens)} tokens)`
              : '';
          setItems((prev) => [
            ...prev,
            { id: `meta-${Date.now()}`, kind: 'meta', text: `${trigger} conversation${tokens}` },
          ]);
          break;
        }
        case 'sdk_status':
          setSdkStatus(ev.status);
          if (ev.compactResult === 'failed' && ev.compactError) {
            setItems((prev) => [
              ...prev,
              { id: `meta-${Date.now()}`, kind: 'meta', text: `Compact failed: ${ev.compactError}` },
            ]);
          }
          break;
        case 'slash_command_output': {
          const trimmed = ev.content.trim();
          if (!trimmed) break;
          setItems((prev) => [
            ...prev,
            { id: `meta-${Date.now()}`, kind: 'meta', text: trimmed },
          ]);
          break;
        }
        case 'thinking': {
          // Replace the ticker rather than append — thinking blocks aren't
          // streaming deltas, they're complete chunks; appending would create a
          // run-on wall of text. Trim to the last ~3 lines so a long block
          // doesn't blow up the bar height.
          const trimmed = ev.text.trim();
          if (!trimmed) break;
          const lastLines = trimmed.split('\n').slice(-3).join('\n');
          setThinkingTicker(lastLines);
          break;
        }
        case 'workflow_task': {
          // Live workflow lifecycle (Claude 4.8). Upsert a single card keyed by
          // taskId so started → progress/updated → completed all land on one
          // row. Ambient tasks (skipTranscript) and non-workflow background
          // tasks (which already render via their own tool cards) are skipped.
          if (ev.skipTranscript) break;
          const itemId = `wf-${ev.taskId}`;
          setItems((prev) => {
            const exists = prev.some((it) => it.kind === 'workflow' && it.id === itemId);
            if (!exists) {
              const isWorkflow = Boolean(ev.workflowName) || ev.taskType === 'local_workflow';
              if (!isWorkflow || ev.phase === 'completed') return prev;
              return [
                ...prev,
                {
                  id: itemId,
                  kind: 'workflow',
                  taskId: ev.taskId,
                  workflowName: ev.workflowName,
                  status: ev.status ?? 'running',
                  description: ev.description,
                },
              ];
            }
            return prev.map((it) =>
              it.kind === 'workflow' && it.id === itemId
                ? {
                    ...it,
                    status: ev.status ?? it.status,
                    description: ev.description ?? it.description,
                    summary: ev.summary ?? it.summary,
                    workflowName: ev.workflowName ?? it.workflowName,
                  }
                : it,
            );
          });
          break;
        }
        case 'raw':
          // Unhandled event types are plumbing, not user-facing content, so we
          // drop them. (Do NOT surface these as pills: high-frequency system
          // frames like `thinking_tokens` stream continuously during a turn and
          // would flood the transcript. Workflow task frames have their own
          // typed `workflow_task` event; new SDK features should get the same.)
          break;
      }
    }

    return () => {
      handle.close();
      sendRef.current = null;
      clearCapabilities(agent, id);
      // Drop any cached per-file diffs for this session so a dead session
      // doesn't pin memory. The cache also has an LRU cap as a backstop.
      clearInlineDiffCacheForSession(agent, id);
    };
  }, [conn.baseUrl, conn.token, agent, id, reconnectNonce, setCapabilities, clearCapabilities]);

  // Preview-takeover Phase 0 — mirror the persisted master switch up to
  // the bridge any time it changes (and on every fresh connect). Runs
  // after the stream effect above creates `sendRef.current`. Connection
  // state is part of the dep array so we re-send on every reconnect.
  useEffect(() => {
    if (connState !== 'open') return;
    if (!settings.hydrated) return;
    sendRef.current?.({
      type: 'set_visual_feedback_enabled',
      enabled: settings.enableVisualFeedback,
    });
  }, [connState, settings.hydrated, settings.enableVisualFeedback]);

  // Preview-takeover Phase 0 — one-time onboarding hint. Shows on the
  // first chat session a user opens with the master switch still off.
  // Marked-shown is persisted so we never show it again on this device.
  useEffect(() => {
    if (!settings.hydrated) return;
    if (settings.enableVisualFeedback) return;
    if (settings.visualFeedbackOnboardingShown) return;
    setItems((prev) => [
      ...prev,
      {
        id: `meta-vf-onboarding-${Date.now()}`,
        kind: 'meta',
        text:
          'Visual feedback is off — enable it in Settings if you want Claude to ' +
          'verify changes by capturing your preview.',
      },
    ]);
    void settings.markVisualFeedbackOnboardingShown();
    // Only on the very first session-mount for a fresh device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hydrated]);

  function onSend() {
    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;
    // `/model` and `/mode` are interactive terminal commands that fail
    // headlessly ("isn't available in this environment"). Rove has native
    // pickers for both, so intercept the command and open the picker instead
    // of sending a doomed message.
    if (attachments.length === 0) {
      const cmd = userText.toLowerCase();
      if (cmd === '/model' && capabilities?.modelSelection) {
        setModelPickerOpen(true);
        setDraft('');
        return;
      }
      if (cmd === '/mode' && capabilities?.permissionModes && capabilities.permissionModes.length > 0) {
        setModePickerOpen(true);
        setDraft('');
        return;
      }
    }
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

  // Visual-feedback-loop Phase 2 / preview-takeover Phase 1 —
  // agent-initiated capture is now driven by the TakeoverController
  // (`mobile/components/takeover/`). The chat screen forwards the WS
  // frame via `takeoverFrameHandler.current(msg)` and the controller
  // owns the rest (state machine, indicator, pager swap, capture,
  // restore). No inline `handleScreenshotRequest` lives here anymore.

  // Shutter handler — captures the PreviewPane WebView, uploads the PNG,
  // and opens the composer. The composer renders a spinner until the
  // upload resolves; on Send we route through sendScreenshot, on Cancel
  // we just discard the upload reference (the file lives on the bridge
  // but isn't referenced anywhere; existing upload-GC handles it).
  async function onShutterPress() {
    if (!screenshot.supported) {
      Alert.alert(
        'Screenshot unavailable',
        'Capturing the preview is only supported on the iOS / Android app, not the web client.',
      );
      return;
    }
    // Open the composer in loading state immediately so the user sees
    // the affordance even if upload takes a beat.
    setShotComposerOpen(true);
    setShotUpload(null);
    setShotFlashNonce((n) => n + 1);
    try {
      const { upload } = await screenshot.captureAndUpload();
      setShotUpload(upload);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      setShotComposerOpen(false);
      setItems((prev) => [
        ...prev,
        { id: `meta-${Date.now()}`, kind: 'meta', text: `Screenshot failed: ${msg}` },
      ]);
    }
  }

  // Send the captured screenshot as a normal multimodal user turn — same
  // wire shape as the chat composer's photo-attachment path, just
  // pre-built so the composer's only job is the note.
  function sendScreenshot({ note, upload }: { note: string; upload: UploadResult }) {
    if (!sendRef.current) return;
    const attachLine = `[Attached image: ${upload.rel}]`;
    const composed = note ? `${attachLine}\n\n${note}` : attachLine;
    setPendingTurns((n) => n + 1);
    setItems((prev) => [
      ...prev,
      { id: `local-u-${Date.now()}`, kind: 'user', text: composed, live: true },
    ]);
    stickToBottomRef.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    try {
      sendRef.current({ type: 'user_message', content: composed });
    } catch (err) {
      setPendingTurns((n) => Math.max(0, n - 1));
      setItems((prev) => [
        ...prev,
        { id: `meta-${Date.now()}`, kind: 'meta', text: `Send failed: ${String((err as Error).message)}` },
      ]);
    }
    setShotComposerOpen(false);
    setShotUpload(null);
    // Auto-swap pager to chat so the user sees Claude's response come in.
    pagerRef.current?.setIndex(0);
  }

  async function runUpload(kind: 'image' | 'photo' | 'document') {
    setAttachMenuOpen(false);
    if (uploading) return;
    setUploading(true);
    try {
      const cfg = conn;
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

  // Splice `insertion` into the draft, replacing the `@<token>` the picker
  // was anchored on. Append a trailing space so the next keystroke starts a
  // new word — keeps the picker from re-opening immediately on the same
  // token. The one-shot `pendingSelection` forces the caret past the
  // inserted text on the very next render; React Native then releases
  // control as soon as the user (or RN's own re-layout) emits the next
  // selection event.
  const onMentionPick = useCallback(
    (insertion: string, range: { start: number; end: number }) => {
      const inserted = `${insertion} `;
      setDraft((prev) => prev.slice(0, range.start) + inserted + prev.slice(range.end));
      const nextCaret = range.start + inserted.length;
      setDraftCaret(nextCaret);
      setPendingSelection({ start: nextCaret, end: nextCaret });
      // Re-focus the input — on iOS the picker tap can momentarily steal
      // focus even with keyboardShouldPersistTaps; this restores it.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  async function onLoadOlder() {
    if (loadingOlder || !olderCursor.hasMore || !olderCursor.before) return;
    setLoadingOlder(true);
    const wasStuck = stickToBottomRef.current;
    stickToBottomRef.current = false;
    try {
      const page = await fetchHistory(
        conn,
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
          conn,
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
    [conn.baseUrl, conn.token, agent, id],
  );

  const onFork = useCallback(
    (atMessage?: string) => {
      const title = atMessage ? 'Fork from here?' : 'Fork this session?';
      const body = atMessage
        ? 'Creates a copy of the conversation branching at this message. The original is unchanged.'
        : 'Creates a copy of the conversation as a new session. The original is unchanged.';
      Alert.alert(title, body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Fork',
          onPress: async () => {
            try {
              const res = await forkSession(
                conn,
                agent,
                id,
                atMessage ? { atMessage } : undefined,
              );
              router.replace(
                `/sessions/${agent}/${res.sessionId}${connBridge ? `?bridge=${connBridge.id}` : ''}`,
              );
            } catch (err) {
              Alert.alert('Fork failed', String((err as Error).message ?? err));
            }
          },
        },
      ]);
  }, [conn.baseUrl, conn.token, agent, id]);

  // Per-session "Disable visual verification" is the only action that
  // still lives behind the header overflow. "Open diff" moved to the
  // Files pane (tap a row in "Changed this session" → per-file diff)
  // and "Fork session" moved to the long-press bubble menu as
  // `forkAction(messageId)` — fork-from-here is strictly more useful
  // than fork-from-head. When this list ends up empty (most users,
  // most of the time) the header trigger hides entirely.
  const headerMenuItems = useMemo<
    Array<{ text: string; onPress: () => void; style?: 'cancel' | 'default' | 'destructive' }>
  >(() => {
    const items: Array<{
      text: string;
      onPress: () => void;
      style?: 'cancel' | 'default' | 'destructive';
    }> = [];
    if (capabilities?.screenshotCapture && settings.enableVisualFeedback) {
      items.push({
        text: allowVisualVerification
          ? 'Disable visual verification'
          : 'Allow visual verification',
        onPress: () => {
          const next = !allowVisualVerification;
          setAllowVisualVerification(next);
          sendRef.current?.({ type: 'set_screenshot_allow', allow: next });
        },
      });
    }
    return items;
  }, [
    capabilities?.screenshotCapture,
    settings.enableVisualFeedback,
    allowVisualVerification,
  ]);

  const showHeaderMenu = headerMenuItems.length > 0;

  const onHeaderMenu = useCallback(() => {
    if (headerMenuItems.length === 0) return;
    Alert.alert(sessionLabel ?? sessionProject ?? 'Session', undefined, [
      ...headerMenuItems,
      { text: 'Cancel', style: 'cancel' as const, onPress: () => undefined },
    ]);
  }, [headerMenuItems, sessionLabel, sessionProject]);

  const onRewindRequest = useCallback(
    (messageId: string) => {
      Alert.alert(
        'Rewind to here?',
        'Restores files to their state right before this turn. Chat history past this point is dropped.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Rewind',
            style: 'destructive',
            onPress: () => sendRef.current?.({ type: 'rewind_to', messageId }),
          },
        ],
      );
    },
    [],
  );

  async function onApprovalDecision(decision: 'allow' | 'allow_always' | 'deny') {
    if (!approval) return;
    const toolUseId = approval.toolUseId;
    setApproval(null);

    // Fast path: live WS is open — send on the existing socket so the bridge
    // resolves the prompt without any extra round-trip.
    if (connState === 'open' && sendRef.current) {
      try {
        sendRef.current({ type: 'approval', toolUseId, decision });
        return;
      } catch {
        // Live socket flaked between our check and the send — fall through.
      }
    }

    // Fallback: one-shot WS, same path the sessions-list approval chip uses.
    // Survives the case where the user reopens the app, taps Allow on the
    // replayed ApprovalSheet, and the live chat WS is still mid-reconnect.
    try {
      await sendApproval(
        conn,
        agent,
        id,
        toolUseId,
        decision,
      );
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
  }

  const statusLabel = useMemo(() => {
    if (connState === 'connecting') return 'connecting';
    if (connState === 'closed' || connState === 'error') return 'disconnected';
    return status === 'live-bridge' ? 'live · phone' : status === 'live-desktop' ? 'live · desktop' : 'idle';
  }, [connState, status]);

  if (!settings.hydrated || !conn.baseUrl) {
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
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
          // Burger opens an in-place sidebar drawer with the session list
          // so the user can swap chats without losing the current screen's
          // scroll position or stacking history.
          headerLeft: () => (
            <Pressable
              onPress={() => setSidebarOpen(true)}
              hitSlop={8}
              style={styles.headerLeftButton}>
              <Ionicons name="menu" size={fontSize['4xl']} color={t.accent.primary} />
            </Pressable>
          ),
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
          // Hide the overflow trigger entirely when there's nothing to
          // show. "Files changed" no longer rides on the badge — that
          // moved to the workspace dot in <ChatPreviewPager> (see
          // `pageBadges`). Fork moved to long-press → "Fork from here."
          headerRight: showHeaderMenu
            ? () => (
                <Pressable
                  onPress={onHeaderMenu}
                  hitSlop={8}
                  style={styles.headerRightButton}>
                  <Ionicons
                    name="ellipsis-horizontal-circle"
                    size={fontSize['4xl']}
                    color={t.accent.primary}
                  />
                </Pressable>
              )
            : undefined,
        }}
      />
      <View style={[styles.statusBar, { borderBottomColor: t.border.subtle }]}>
        <Text style={[styles.statusBarText, { color: t.text.secondary }]} numberOfLines={1}>
          {statusLabel} · {agent} · {id.slice(0, 8)} · {items.length}
        </Text>
        <View style={styles.chipRow}>
          {capabilities?.modelSelection ? (
            <Pressable
              onPress={() => setModelPickerOpen((o) => !o)}
              hitSlop={6}
              style={[styles.modeChip, { borderColor: t.border.subtle, backgroundColor: t.surface.raised }]}>
              <Text style={[styles.modeChipLabel, { color: t.accent.primary }]} numberOfLines={1}>
                model:{' '}
                {capabilities.modelSelection.available.find(
                  (m) => m.value === capabilities.modelSelection!.current,
                )?.label ?? modelDisplay(capabilities.modelSelection.current)}{' '}
                ▾
              </Text>
            </Pressable>
          ) : null}
          {capabilities?.permissionModes && capabilities.permissionModes.length > 0 ? (
            <Pressable
              onPress={() => setModePickerOpen((o) => !o)}
              hitSlop={6}
              style={[styles.modeChip, { borderColor: t.border.subtle, backgroundColor: t.surface.raised }]}>
              <Text style={[styles.modeChipLabel, { color: t.accent.primary }]} numberOfLines={1}>
                mode: {MODE_LABEL[permissionMode]} ▾
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {modelPickerOpen && capabilities?.modelSelection ? (
        <View style={[styles.modePicker, { borderBottomColor: t.border.subtle, backgroundColor: t.surface.sunken }]}>
          {(capabilities.modelSelection.available.length > 0
            ? capabilities.modelSelection.available
            : [{ value: capabilities.modelSelection.current, label: modelDisplay(capabilities.modelSelection.current) }]
          ).map((m) => {
            const active = m.value === capabilities.modelSelection!.current;
            return (
              <Pressable
                key={m.value}
                onPress={() => {
                  setModelPickerOpen(false);
                  if (!active) sendRef.current?.({ type: 'set_model', model: m.value });
                }}
                style={({ pressed }) => [
                  styles.modeOption,
                  {
                    backgroundColor: active
                      ? t.accent.primary
                      : pressed
                        ? t.surface.pressed
                        : t.surface.raised,
                    borderColor: active ? t.accent.primary : t.border.subtle,
                  },
                ]}>
                <View style={styles.modeOptionHeader}>
                  <Text
                    style={[styles.modeOptionLabel, { color: active ? t.accent.fg : t.text.primary }]}>
                    {m.label}
                  </Text>
                  {active ? (
                    <Text style={[styles.modeOptionBadge, { color: t.accent.fg }]}>current</Text>
                  ) : null}
                </View>
                {m.description ? (
                  <Text
                    style={[
                      styles.modeOptionDescription,
                      { color: active ? t.accent.fg : t.text.secondary },
                    ]}
                    numberOfLines={2}>
                    {m.description}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
          {capabilities.modelSelection.available.length === 0 ? (
            <Text style={[styles.modeOptionDescription, { color: t.text.secondary }]} numberOfLines={2}>
              Loading available models… tap again in a moment.
            </Text>
          ) : null}
        </View>
      ) : null}
      {modePickerOpen && capabilities?.permissionModes ? (
        <View style={[styles.modePicker, { borderBottomColor: t.border.subtle, backgroundColor: t.surface.sunken }]}>
          {capabilities.permissionModes.map((m) => {
            const active = m === permissionMode;
            return (
              <Pressable
                key={m}
                onPress={() => {
                  setModePickerOpen(false);
                  if (m !== permissionMode) {
                    sendRef.current?.({ type: 'set_mode', mode: m });
                  }
                }}
                style={({ pressed }) => [
                  styles.modeOption,
                  {
                    backgroundColor: active
                      ? t.accent.primary
                      : pressed
                        ? t.surface.pressed
                        : t.surface.raised,
                    borderColor: active ? t.accent.primary : t.border.subtle,
                  },
                ]}>
                <Text
                  style={[
                    styles.modeOptionLabel,
                    { color: active ? t.accent.fg : t.text.primary },
                  ]}>
                  {MODE_LABEL[m]}
                </Text>
                <Text
                  style={[
                    styles.modeOptionDescription,
                    { color: active ? t.accent.fg : t.text.secondary },
                  ]}
                  numberOfLines={2}>
                  {MODE_DESCRIPTION[m]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {changedFiles.size > 0 ? (
        <View style={[styles.filesPane, { borderBottomColor: t.border.subtle }]}>
          <Pressable onPress={() => setFilesPaneOpen((o) => !o)} style={styles.filesPaneHeader}>
            <Text style={[styles.filesPaneLabel, { color: t.text.primary }]}>
              📂 {changedFiles.size} file{changedFiles.size === 1 ? '' : 's'} changed
            </Text>
            {/* "View diff" (all-files diff page) link removed — the
                workspace Files tab is one swipe away with the same
                "Changed this session" list, and tapping a row in the
                accordion below already opens the per-file diff which
                is the view most users actually want. */}
            <Text style={[styles.filesPaneToggle, { color: t.text.secondary }]}>
              {filesPaneOpen ? '▲' : '▼'}
            </Text>
          </Pressable>
          {filesPaneOpen ? (
            <View style={styles.filesList}>
              {Array.from(changedFiles.entries()).map(([path, op]) => {
                const o = opStyle(op, t);
                const encoded = encodeURIComponent(path);
                return (
                  <Pressable
                    key={path}
                    // Tap → per-file diff (Phase 2). Long-press → full file
                    // viewer (the old default behavior, kept as an escape
                    // hatch for "I want to see the current contents, not
                    // just what changed").
                    onPress={() =>
                      router.push(
                        `/sessions/${agent}/${id}/diff?path=${encoded}${connBridge ? `&bridge=${connBridge.id}` : ''}`,
                      )
                    }
                    onLongPress={() =>
                      router.push(
                        `/sessions/${agent}/${id}/file?path=${encoded}${connBridge ? `&bridge=${connBridge.id}` : ''}`,
                      )
                    }
                    delayLongPress={350}
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
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingVertical: space[2],
          paddingHorizontal: space[3],
          gap: space[2] + 2,
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
              <ChatRow
                item={item}
                agent={agent}
                sessionId={id}
                onTakeover={onTakeover}
                rewindEnabled={Boolean(capabilities?.fileCheckpointing)}
                onRewindRequest={onRewindRequest}
                forkEnabled={Boolean(capabilities?.sessionForking)}
                onForkRequest={(mid) => onFork(mid)}
                onRequestMenu={(anchor, actions) => setBubbleMenu({ anchor, actions })}
              />
            </View>
          );
        }}
        initialNumToRender={30}
        maxToRenderPerBatch={20}
        windowSize={9}
        // react-native-web can leave clipped rows detached (blank) until a
        // scroll/resize event fires, so messages don't show right away on open.
        // The clipping optimization isn't worth that on web; keep it native-only.
        removeClippedSubviews={Platform.OS === 'web' ? false : undefined}
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
        ListFooterComponent={null}
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
      {sdkStatus === SDK_RUN_STATUS.compacting || sending || thinkingTicker ? (
        <View
          style={[
            styles.liveStatusBar,
            { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken },
          ]}>
          <ThinkingDot color={t.text.secondary} />
          <Text
            style={[styles.liveStatusText, { color: t.text.secondary }]}
            numberOfLines={2}>
            {sdkStatus === SDK_RUN_STATUS.compacting
              ? `Compacting conversation… ${compactSeconds}s`
              : thinkingTicker
                ? thinkingTicker
                : 'Claude is thinking…'}
          </Text>
        </View>
      ) : null}
      {capabilities?.projectBrowser ? (
        <MentionPicker
          agent={agent}
          sessionId={id}
          draft={draft}
          caret={draftCaret}
          refreshKey={mentionRefreshKey}
          onPick={onMentionPick}
        />
      ) : null}
      {draft.startsWith('/') ? (
        <SlashPicker
          draft={draft}
          commands={buildSlashCommands(capabilities?.supportedCommands)}
          onPick={(cmd) => setDraft(cmd + ' ')}
        />
      ) : null}
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          style={[styles.attachBar, { borderTopColor: t.border.subtle, backgroundColor: t.surface.sunken }]}
          contentContainerStyle={{ gap: space[2], paddingHorizontal: space[2] + 2, alignItems: 'center' }}>
          {attachments.map((a, i) => (
            <View key={`${a.rel}-${i}`} style={[styles.attachChip, { backgroundColor: t.surface.raised, borderColor: t.border.subtle }]}>
              {a.isImage && a.localUri ? (
                <Image source={{ uri: a.localUri }} style={styles.attachThumb} />
              ) : (
                <Ionicons
                  name={a.isImage ? 'image-outline' : 'document-attach-outline'}
                  size={fontSize.lg}
                  color={t.text.secondary}
                />
              )}
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
            <Ionicons name="image-outline" size={fontSize.lg} color={t.text.primary} />
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>Photo library</Text>
          </Pressable>
          <Pressable
            onPress={() => runUpload('photo')}
            style={({ pressed }) => [
              styles.attachOption,
              { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
            ]}>
            <Ionicons name="camera-outline" size={fontSize.lg} color={t.text.primary} />
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>Take photo</Text>
          </Pressable>
          <Pressable
            onPress={() => runUpload('document')}
            style={({ pressed }) => [
              styles.attachOption,
              { backgroundColor: pressed ? t.surface.pressed : t.surface.raised, borderColor: t.border.subtle },
            ]}>
            <Ionicons name="document-outline" size={fontSize.lg} color={t.text.primary} />
            <Text style={[styles.attachLabel, { color: t.text.primary }]}>File</Text>
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
          ref={inputRef}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            // Keep the caret tracked even between selection events; typing
            // at end-of-input doesn't always fire onSelectionChange first.
            setDraftCaret(text.length);
          }}
          onSelectionChange={(e) => {
            setDraftCaret(e.nativeEvent.selection.start);
            // Release the one-shot selection override on the first natural
            // selection event after a mention insertion.
            if (pendingSelection) setPendingSelection(null);
          }}
          selection={pendingSelection ?? undefined}
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
      {capabilities?.permissionPrompts !== false ? (
        <ApprovalSheet
          approval={approval}
          onDecision={onApprovalDecision}
          // Preview-takeover Phase 0: when the user has opted into
          // "Always ask before each capture," hide the "Always allow"
          // button for visual-feedback tools so the user is prompted on
          // every call. Other tools are unaffected.
          suppressAllowAlways={
            settings.alwaysAskBeforeCapture &&
            approval !== null &&
            isVisualFeedbackTool(approval.tool)
          }
        />
      ) : null}
    </KeyboardAvoidingView>
  );

  return (
    <>
      <ChatPreviewPager
        ref={pagerRef}
        panRef={pagerPanRef}
        chat={chatBody}
        workspace={(active) => (
          <WorkspacePane
            ref={workspaceRef}
            active={active}
            files={(filesActive) => (
              <FilesPane
                agent={agent}
                sessionId={id}
                active={filesActive}
                sessionChanges={changedFiles}
                capabilities={capabilities}
              />
            )}
            preview={(previewActive) => (
              <PreviewPane
                agent={agent}
                id={id}
                active={previewActive}
                captureRef={screenshot.targetRef}
                previewFrameRef={previewFrameRef}
              />
            )}
            previewOverlay={
              screenshot.supported && settings.enableVisualFeedback ? (
                <>
                  <ShutterFlash nonce={shotFlashNonce} />
                  <PreviewShutter
                    onCapture={onShutterPress}
                    disabled={shotComposerOpen || manualShutterLocked}
                  />
                </>
              ) : null
            }
          />
        )}
        onIndexChange={setPagerIndex}
        // Files-side dot pulses in the accent color whenever this
        // session has touched files but the user isn't currently on
        // the workspace pane. Replaces the old "N changed" badge that
        // used to ride on the header overflow trigger.
        pageBadges={[false, changedFiles.size > 0]}
      />
      {/* Preview-takeover Phase 1 — the controller subscribes to the
          frame handler we register here and drives the state machine,
          imperative ref calls, and indicator. The chat screen stays
          oblivious to the takeover-mode internals. */}
      <TakeoverController
        pagerRef={pagerRef}
        workspaceRef={workspaceRef}
        previewFrameRef={previewFrameRef}
        screenshot={screenshot}
        sendFrame={(m) => sendRef.current?.(m)}
        registerFrameHandler={registerTakeoverFrameHandler}
        onManualShutterAvailability={setManualShutterLocked}
      />
      <SessionsSidebar
        visible={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentAgent={agent}
        currentSessionId={id}
        currentBridgeId={connBridge?.id ?? ''}
      />
      <BubbleActionMenu
        visible={bubbleMenu !== null}
        anchor={bubbleMenu?.anchor ?? null}
        actions={bubbleMenu?.actions ?? []}
        onClose={() => setBubbleMenu(null)}
      />
      <ScreenshotComposer
        visible={shotComposerOpen}
        upload={shotUpload}
        onSend={sendScreenshot}
        onCancel={() => {
          setShotComposerOpen(false);
          setShotUpload(null);
        }}
      />
      {/* Cross-session approvals — surfaces *other* sessions' pending permission
          requests (whisper → badge → tray) without leaving this chat. The
          focused session's own requests stay on the ApprovalSheet above. */}
      <CrossSessionApprovals
        currentAgent={agent}
        currentSessionId={id}
        currentBridgeId={connBridge?.id ?? ''}
        pagerGestureRef={pagerPanRef}
      />
    </>
  );
}

/**
 * Soft 1.0 → 0.4 pulsing dot. Replaces the platform spinner in the
 * "Claude is thinking…" footer — the native ActivityIndicator reads
 * heavy next to a single line of italic text on mobile.
 */
function ThinkingDot({ color }: { color: string }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] });
  return <Animated.View style={[styles.thinkingDot, { backgroundColor: color, opacity }]} />;
}

/** Live/completed workflow run (Claude 4.8 /workflow). Reuses the pulsing
 *  ThinkingDot while running; flips to a solid status dot when terminal. */
function WorkflowCard({ item }: { item: Extract<ChatItem, { kind: 'workflow' }> }) {
  const t = useTheme();
  const status = item.status ?? 'running';
  const running = status === 'running' || status === 'pending' || status === 'paused';
  const failed = status === 'failed' || status === 'killed' || status === 'stopped';
  const accent = failed ? t.status.danger : status === 'completed' ? t.status.success : t.accent.primary;
  return (
    <View
      style={[
        styles.workflowCard,
        { backgroundColor: t.surface.raised, borderColor: t.border.subtle, borderLeftColor: accent },
      ]}>
      <View style={styles.workflowHeader}>
        {running ? (
          <ThinkingDot color={accent} />
        ) : (
          <View style={[styles.workflowDot, { backgroundColor: accent }]} />
        )}
        <Text style={[styles.workflowTitle, { color: t.text.primary }]} numberOfLines={1}>
          Workflow{item.workflowName ? ` · ${item.workflowName}` : ''}
        </Text>
        <Text style={[styles.workflowStatus, { color: accent }]}>{status}</Text>
      </View>
      {item.description ? (
        <Text style={[styles.workflowBody, { color: t.text.secondary }]} numberOfLines={4}>
          {item.description}
        </Text>
      ) : null}
      {item.summary ? (
        <Text style={[styles.workflowBody, { color: t.text.secondary }]}>{item.summary}</Text>
      ) : null}
    </View>
  );
}

function SlashPicker({
  draft,
  commands,
  onPick,
}: {
  draft: string;
  commands: SlashCmd[];
  onPick: (cmd: string) => void;
}) {
  const t = useTheme();
  const q = draft.trim().toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().startsWith(q));
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
    agent,
    sessionId,
    onTakeover,
    rewindEnabled,
    onRewindRequest,
    forkEnabled,
    onForkRequest,
    onRequestMenu,
  }: {
    item: ChatItem;
    agent: string;
    sessionId: string;
    onTakeover: (pendingMessage: string) => void;
    rewindEnabled: boolean;
    onRewindRequest: (messageId: string) => void;
    /** Capability-gated `sessionForking` on the agent. When true and
     *  the bubble has a messageId, long-press surfaces "Fork from
     *  here." Replaces the old header-menu "Fork session" item which
     *  could only fork from HEAD. */
    forkEnabled: boolean;
    onForkRequest: (messageId: string) => void;
    onRequestMenu: (anchor: BubbleMenuAnchor, actions: BubbleAction[]) => void;
  }) {
    const t = useTheme();

    if (item.kind === 'user') {
      const canFork = forkEnabled && Boolean(item.messageId);
      return (
        <PressableBubble
          onLongPress={(e) => {
            triggerOpenHaptic();
            const actions: BubbleAction[] = [copyAction(item.text)];
            if (canFork && item.messageId) {
              actions.push(forkAction(item.messageId, onForkRequest));
            }
            onRequestMenu(
              { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
              actions,
            );
          }}
          style={[styles.bubbleUser, { backgroundColor: t.bubble.userBg }]}>
          <Markdown text={item.text.trim()} color={t.bubble.userFg} />
        </PressableBubble>
      );
    }
    if (item.kind === 'assistant') {
      const canRewind = rewindEnabled && Boolean(item.messageId);
      const canFork = forkEnabled && Boolean(item.messageId);
      return (
        <PressableBubble
          onLongPress={(e) => {
            triggerOpenHaptic();
            const actions: BubbleAction[] = [copyAction(item.text)];
            if (canRewind && item.messageId) {
              actions.push(rewindAction(item.messageId, onRewindRequest));
            }
            if (canFork && item.messageId) {
              actions.push(forkAction(item.messageId, onForkRequest));
            }
            onRequestMenu(
              { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
              actions,
            );
          }}
          style={[styles.bubbleAssistant, { backgroundColor: t.bubble.assistantBg }]}>
          <Markdown text={item.text.trim()} color={t.bubble.assistantFg} />
        </PressableBubble>
      );
    }
    if (item.kind === 'tool_use') {
      return (
        <ToolUseCard
          agent={agent}
          sessionId={sessionId}
          name={item.name}
          input={item.input}
          running={item.running}
        />
      );
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
    if (item.kind === 'workflow') {
      return <WorkflowCard item={item} />;
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
    if (prev.agent !== next.agent) return false;
    if (prev.rewindEnabled !== next.rewindEnabled) return false;
    if (prev.onRewindRequest !== next.onRewindRequest) return false;
    if (prev.onTakeover !== next.onTakeover) return false;
    if (prev.item.id !== next.item.id) return false;
    if (prev.item.kind !== next.item.kind) return false;
    if (prev.item.kind === 'assistant' && next.item.kind === 'assistant') {
      return prev.item.text === next.item.text;
    }
    if (prev.item.kind === 'tool_use' && next.item.kind === 'tool_use') {
      return prev.item.running === next.item.running;
    }
    if (prev.item.kind === 'workflow' && next.item.kind === 'workflow') {
      return (
        prev.item.status === next.item.status &&
        prev.item.description === next.item.description &&
        prev.item.summary === next.item.summary &&
        prev.item.workflowName === next.item.workflowName
      );
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  statusBarText: { fontSize: fontSize.sm, flexShrink: 1 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: space[1.5] },
  modeChip: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modeChipLabel: { fontSize: fontSize.xs, fontWeight: '600' },
  modePicker: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: space[1.5],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modeOption: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  modeOptionLabel: { fontSize: fontSize.base, fontWeight: '700' },
  modeOptionDescription: { fontSize: fontSize.sm },
  modeOptionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  modeOptionBadge: { fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
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
  workflowCard: {
    alignSelf: 'stretch',
    marginVertical: 4,
    padding: space[3],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    gap: space[2],
  },
  workflowHeader: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  workflowDot: { width: 8, height: 8, borderRadius: 4 },
  workflowTitle: { flex: 1, fontSize: fontSize.base, fontWeight: '600' },
  workflowStatus: { fontSize: fontSize.xs, fontWeight: '700', textTransform: 'lowercase' },
  workflowBody: { fontSize: fontSize.sm, lineHeight: 19 },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
    alignSelf: 'flex-start',
  },
  thinkingText: { fontSize: fontSize.base, fontStyle: 'italic' },
  liveStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  thinkingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  liveStatusText: {
    flex: 1,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
  },
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
    // iOS Safari auto-zooms when a focused field's font-size is < 16px. Keep
    // native at the tighter 15px, but use 16px on web to suppress the zoom.
    fontSize: Platform.OS === 'web' ? fontSize.xl : fontSize.lg,
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
    maxHeight: 72,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1.5],
    paddingLeft: space[1],
    paddingRight: space[2] + 2,
    paddingVertical: space[1],
    borderRadius: radius['2xl'] - 2,
    borderWidth: 1,
  },
  attachThumb: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
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
    gap: space[1],
  },
  attachLabel: { fontSize: fontSize.base, fontWeight: '500' },
  attachButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  attachIcon: { fontSize: fontSize.xl, fontWeight: '700', lineHeight: 22 },
  headerRightButton: {
    paddingHorizontal: space[2],
    paddingVertical: space[1],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  headerLeftButton: {
    paddingHorizontal: space[2],
    paddingVertical: space[1],
    alignItems: 'center',
    justifyContent: 'center',
  },
  // headerBadge / headerBadgeText were the "N changed files" pill on
  // the header overflow trigger. The signal moved to the workspace
  // pager dot via `pageBadges` so we no longer need them.
});
