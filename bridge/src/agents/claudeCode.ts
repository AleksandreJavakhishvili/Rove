import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdir, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { config } from '../config.ts';
import { getHeadSha } from '../git.ts';
import { attributeClaudePids, getLiveClaudes } from '../lsof.ts';
import { getMcpConfig } from '../permissions.ts';
import { runtime } from '../runtime.ts';
import type { HistoryEntry } from '../types.ts';
import type {
  AgentDriver,
  AgentEvent,
  AgentSession,
  DriverSessionListItem,
  PermissionMode,
} from './types.ts';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

interface FirstEntryPeek {
  cwd?: string;
  firstUserMessage?: string;
}

async function peekFirstEntries(path: string, maxBytes = 65536): Promise<FirstEntryPeek> {
  const result: FirstEntryPeek = {};
  let buf = Buffer.alloc(0);
  const fh = await open(path, 'r');
  try {
    const tmp = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(tmp, 0, maxBytes, 0);
    buf = tmp.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const text = buf.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!result.cwd && typeof obj.cwd === 'string') result.cwd = obj.cwd;
    if (!result.firstUserMessage && obj.type === 'user' && obj.message?.role === 'user') {
      const content = obj.message.content;
      if (typeof content === 'string') {
        result.firstUserMessage = content;
      } else if (Array.isArray(content)) {
        const txt = content.find((c) => c?.type === 'text');
        if (txt?.text) result.firstUserMessage = String(txt.text);
      }
    }
    if (result.cwd && result.firstUserMessage) break;
  }
  return result;
}

function decodeProjectDir(encoded: string): string {
  return encoded.replaceAll('-', '/');
}

export function entryFromRaw(obj: any): HistoryEntry[] | null {
  const ts = obj.timestamp ?? new Date(0).toISOString();
  const uuid = obj.uuid ?? `${ts}-${Math.random()}`;
  const parentUuid = obj.parentUuid ?? null;
  // Claude marks sub-agent events with parentToolUseId (the Task tool_use that spawned them).
  const parentToolUseId: string | undefined =
    obj.parentToolUseId ?? obj.parent_tool_use_id ?? undefined;

  if (obj.type === 'user' && obj.message?.role === 'user') {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      const out: HistoryEntry[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            uuid: `${uuid}:${block.tool_use_id}`,
            parentUuid,
            timestamp: ts,
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: Boolean(block.is_error),
            parentToolUseId,
          });
        } else if (block?.type === 'text') {
          out.push({ kind: 'user', uuid, parentUuid, timestamp: ts, content: block.text, parentToolUseId });
        }
      }
      return out.length ? out : null;
    }
    return [{ kind: 'user', uuid, parentUuid, timestamp: ts, content, parentToolUseId }];
  }

  if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
    const content = obj.message.content;
    const out: HistoryEntry[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') {
          out.push({
            kind: 'assistant',
            uuid: `${uuid}:t`,
            parentUuid,
            timestamp: ts,
            content: block.text,
            model: obj.message.model,
            parentToolUseId,
          });
        } else if (block?.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            uuid: `${uuid}:${block.id}`,
            parentUuid,
            timestamp: ts,
            name: block.name,
            input: block.input,
            toolUseId: block.id,
            parentToolUseId,
          });
        }
      }
    } else if (typeof content === 'string') {
      out.push({ kind: 'assistant', uuid, parentUuid, timestamp: ts, content, parentToolUseId });
    }
    return out.length ? out : null;
  }

  if (obj.type === 'attachment' && obj.attachment) {
    return [
      {
        kind: 'system',
        uuid,
        timestamp: ts,
        subtype: obj.attachment.type ?? 'attachment',
        content: obj.attachment,
      },
    ];
  }
  return null;
}

/**
 * Translates a single Claude stream-json line into one or more normalized
 * AgentEvents. Returns `[]` if the line is metadata we don't surface.
 */
function streamLineToEvents(obj: any): AgentEvent[] {
  // Sub-agents (spawned via Task) attach parent_tool_use_id to every event they emit.
  // Thread it through so the mobile UI can nest sub-agent activity under its parent.
  const parentToolUseId: string | undefined =
    obj?.parent_tool_use_id ?? obj?.parentToolUseId ?? undefined;

  if (obj?.type === 'assistant' && obj.message?.role === 'assistant') {
    const messageId = obj.message.id ?? obj.uuid;
    const events: AgentEvent[] = [];
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') {
          events.push({ type: 'text', role: 'assistant', text: block.text, messageId, parentToolUseId });
        } else if (block?.type === 'tool_use') {
          events.push({ type: 'tool_use', toolUseId: block.id, name: block.name, input: block.input, parentToolUseId });
        } else if (block?.type === 'thinking') {
          events.push({ type: 'thinking', text: block.thinking ?? block.text ?? '', parentToolUseId });
        }
      }
    } else if (typeof content === 'string') {
      events.push({ type: 'text', role: 'assistant', text: content, messageId, parentToolUseId });
    }
    return events;
  }

  if (obj?.type === 'user' && obj.message?.role === 'user') {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: Boolean(block.is_error),
            parentToolUseId,
          });
        }
        // text blocks in user messages are the replayed user input; surface as text
        if (block?.type === 'text') {
          events.push({ type: 'text', role: 'user', text: block.text, parentToolUseId });
        }
      }
      return events;
    }
    return [{ type: 'text', role: 'user', text: String(content), parentToolUseId }];
  }

  if (obj?.type === 'stream_event' && obj.event) {
    // Partial delta — surface as text_delta. Schema: { event: {type:'content_block_delta', delta:{type:'text_delta', text}, ...} }
    const ev = obj.event;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return [
        {
          type: 'text_delta',
          role: 'assistant',
          delta: ev.delta.text ?? '',
          parentToolUseId,
        },
      ];
    }
    return [{ type: 'raw', payload: obj }];
  }

  if (obj?.type === 'result') {
    return [{ type: 'result', subtype: obj.subtype ?? 'success', durationMs: obj.duration_ms, usage: obj.usage }];
  }

  if (obj?.type === 'permission_request' || obj?.type === 'permission_prompt') {
    return [
      {
        type: 'permission_request',
        toolUseId: obj.tool_use_id ?? obj.toolUseId ?? '',
        tool: obj.tool_name ?? obj.tool ?? '',
        input: obj.input ?? obj.tool_input ?? {},
        parentToolUseId,
      },
    ];
  }

  // system/init/control messages: surface as raw so the client can see them but not break.
  return [{ type: 'raw', payload: obj }];
}

const VALID_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function envMode(): PermissionMode {
  const raw = process.env.PERMISSION_MODE;
  return raw && (VALID_MODES as string[]).includes(raw) ? (raw as PermissionMode) : 'default';
}

class ClaudeCodeSession extends EventEmitter implements AgentSession {
  readonly agent = 'claude-code' as const;
  readonly sessionId: string;
  readonly cwd: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  lastActivity = Date.now();
  subscribers = 0;
  baselineSha: string | null = null;
  permissionMode: PermissionMode = envMode();

  constructor(sessionId: string, cwd: string) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  spawnIfNeeded(): void {
    if (this.alive) return;
    // Auto-approve safe read-only tools; prompt-via-MCP on everything else.
    const safeAutoAllow = process.env.AUTO_ALLOW_TOOLS ?? 'Read Grep Glob Ls WebSearch';
    const mcpConfig = getMcpConfig({
      ROVE_SESSION_AGENT: 'claude-code',
      ROVE_SESSION_ID: this.sessionId,
    });
    const args = [
      '--print',
      '--resume',
      this.sessionId,
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode',
      this.permissionMode,
      '--allowedTools',
      safeAutoAllow,
      '--mcp-config',
      mcpConfig,
      '--permission-prompt-tool',
      'mcp__rove__permission_prompt',
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.claudeBin, args, {
        cwd: this.cwd,
        env: { ...process.env, ROVE_BRIDGE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error(`[claude ${this.sessionId.slice(0, 8)}] spawn threw:`, err);
      throw err;
    }
    console.log(
      `[claude ${this.sessionId.slice(0, 8)}] spawned pid=${child.pid} bin=${config.claudeBin}`,
    );
    this.child = child;
    this.lastActivity = Date.now();

    // Capture git baseline lazily on first spawn so the diff endpoint can show
    // "everything this session changed."
    if (!this.baselineSha) {
      getHeadSha(this.cwd).then((sha) => {
        this.baselineSha = sha;
      });
    }

    if (child.pid !== undefined) this.emit('spawn', { pid: child.pid });

    const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // Tags we already route into AgentEvents. Anything outside this set is
    // dumped raw so new event shapes from claude surface in the logs — e.g.
    // internal sed/awk safety prompts, which historically went to TTY but a
    // future claude version may emit as a stream event we haven't wired up.
    const KNOWN_TAGS = new Set([
      'assistant',
      'user',
      'stream_event',
      'result',
      'permission_request',
      'permission_prompt',
    ]);
    rlOut.on('line', (line) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      this.lastActivity = Date.now();
      const tag = obj?.type ?? 'unknown';
      const subtype = obj?.subtype ?? '';
      console.log(`[claude ${this.sessionId.slice(0, 8)}] ← ${tag}${subtype ? '/' + subtype : ''}`);
      if (!KNOWN_TAGS.has(tag)) {
        const dump = JSON.stringify(obj).slice(0, 800);
        console.log(`[claude ${this.sessionId.slice(0, 8)}]   unknown payload: ${dump}`);
      }
      for (const ev of streamLineToEvents(obj)) this.emit('event', ev);
    });

    const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      if (line.trim()) console.error(`[claude ${this.sessionId.slice(0, 8)} stderr] ${line}`);
    });

    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      console.log(`[claude ${this.sessionId.slice(0, 8)}] exited code=${code} signal=${signal}`);
      this.child = null;
      this.emit('exit', { code, signal });
    });
  }

  sendUserMessage(content: string): void {
    if (!this.alive) this.spawnIfNeeded();
    if (!this.child) throw new Error('claude subprocess not alive');
    const payload = { type: 'user', message: { role: 'user', content } };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
    this.lastActivity = Date.now();
  }

  sendApproval(toolUseId: string, decision: 'allow' | 'allow_always' | 'deny'): void {
    if (!this.alive || !this.child) throw new Error('claude subprocess not alive');
    const payload = { type: 'permission_response', tool_use_id: toolUseId, decision };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
    this.lastActivity = Date.now();
  }

  interrupt(): boolean {
    if (this.child && this.alive) {
      this.child.kill('SIGINT');
      return true;
    }
    return false;
  }

  setMode(mode: PermissionMode): void {
    if (!(VALID_MODES as string[]).includes(mode)) return;
    if (this.permissionMode === mode) {
      // Re-emit so a new client subscriber sees the current value.
      this.emit('event', { type: 'permission_mode', mode });
      return;
    }
    this.permissionMode = mode;
    // Surface the new mode to subscribers before respawning so the UI updates
    // even if the next spawn is delayed (no pending user message yet).
    this.emit('event', { type: 'permission_mode', mode });
    // Kill the running child so the next user message respawns with the new
    // --permission-mode arg. Claude CLI doesn't accept a runtime mode swap.
    if (this.child && this.alive) {
      this.child.kill('SIGTERM');
    }
  }

  shutdown(): void {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (this.child && this.alive) this.child.kill('SIGTERM');
    }, 2000);
    setTimeout(() => {
      if (this.child && this.alive) this.child.kill('SIGKILL');
    }, 5000);
  }
}

export class ClaudeCodeDriver implements AgentDriver {
  readonly kind = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  async isAvailable(): Promise<boolean> {
    try {
      await readdir(PROJECTS_DIR);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<DriverSessionListItem[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(PROJECTS_DIR);
    } catch {
      return [];
    }
    // Collect raw file info first so we can batch lsof at the end.
    interface Pending {
      id: string;
      fullPath: string;
      cwd: string;
      lastModified: number;
      sizeBytes: number;
      preview: string;
    }
    const pending: Pending[] = [];
    for (const projectDir of projectDirs) {
      const fullProjectDir = join(PROJECTS_DIR, projectDir);
      let entries: string[];
      try {
        entries = await readdir(fullProjectDir);
      } catch {
        continue;
      }
      for (const fname of entries) {
        if (!SESSION_ID_RE.test(fname)) continue;
        const fullPath = join(fullProjectDir, fname);
        const id = fname.replace(/\.jsonl$/i, '');
        let st;
        try {
          st = await stat(fullPath);
        } catch {
          continue;
        }
        const peek = await peekFirstEntries(fullPath);
        const cwd = peek.cwd ?? decodeProjectDir(projectDir);
        pending.push({
          id,
          fullPath,
          cwd,
          lastModified: st.mtimeMs,
          sizeBytes: st.size,
          preview: (peek.firstUserMessage ?? '').slice(0, 200),
        });
      }
    }

    // Snapshot live `claude` processes once; attribute them per-session below.
    const liveClaudes = await getLiveClaudes();
    const ourPids = new Set<number>();
    for (const pid of runtime.livePids().values()) ourPids.add(pid);

    // Track the most-recently-modified session per project-dir for the
    // attribution heuristic (no --resume in argv → assume the active session is
    // the most recent JSONL in the cwd).
    const mostRecentByProjectDir = new Map<string, string>();
    for (const p of pending) {
      const dir = decodeURIComponent(p.fullPath.replace(/\/[^/]+\.jsonl$/, ''));
      const prev = mostRecentByProjectDir.get(dir);
      if (!prev) {
        mostRecentByProjectDir.set(dir, p.id);
        continue;
      }
      const prevItem = pending.find((q) => q.id === prev);
      if (!prevItem || p.lastModified > prevItem.lastModified) {
        mostRecentByProjectDir.set(dir, p.id);
      }
    }

    const out: DriverSessionListItem[] = pending.map((p) => {
      const projectDir = p.fullPath.replace(/\/[^/]+\.jsonl$/, '');
      const isMostRecent = mostRecentByProjectDir.get(projectDir) === p.id;
      const desktopPids = attributeClaudePids({
        liveClaudes,
        sessionId: p.id,
        isMostRecentInProject: isMostRecent,
        sessionCwd: p.cwd,
        ourPids,
      });
      return {
        id: p.id,
        cwd: p.cwd,
        projectName: basename(p.cwd),
        lastModified: p.lastModified,
        preview: p.preview,
        sizeBytes: p.sizeBytes,
        desktopPids,
      };
    });
    out.sort((a, b) => b.lastModified - a.lastModified);
    return out;
  }

  async getDesktopPids(id: string): Promise<number[]> {
    const located = await this.findSession(id);
    if (!located?.path) return [];
    const liveClaudes = await getLiveClaudes();
    const ourPids = new Set<number>();
    for (const pid of runtime.livePids().values()) ourPids.add(pid);
    // Check whether this session is the most-recently-modified in its project dir.
    const projectDir = located.path.replace(/\/[^/]+\.jsonl$/, '');
    let isMostRecent = true;
    try {
      const entries = await readdir(projectDir);
      let bestId = id;
      let bestMtime = 0;
      for (const fname of entries) {
        if (!SESSION_ID_RE.test(fname)) continue;
        const full = join(projectDir, fname);
        try {
          const s = await stat(full);
          if (s.mtimeMs > bestMtime) {
            bestMtime = s.mtimeMs;
            bestId = fname.replace(/\.jsonl$/i, '');
          }
        } catch {
          // ignore
        }
      }
      isMostRecent = bestId === id;
    } catch {
      // ignore — fall back to true
    }
    return attributeClaudePids({
      liveClaudes,
      sessionId: id,
      isMostRecentInProject: isMostRecent,
      sessionCwd: located.cwd,
      ourPids,
    });
  }

  async findSession(id: string): Promise<{ cwd: string; path?: string } | null> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(PROJECTS_DIR);
    } catch {
      return null;
    }
    for (const projectDir of projectDirs) {
      const candidate = join(PROJECTS_DIR, projectDir, `${id}.jsonl`);
      try {
        const s = await stat(candidate);
        if (s.isFile()) {
          const peek = await peekFirstEntries(candidate);
          return { path: candidate, cwd: peek.cwd ?? decodeProjectDir(projectDir) };
        }
      } catch {
        // not here
      }
    }
    return null;
  }

  async readHistory(
    id: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<HistoryEntry[]> {
    const limit = opts.limit ?? 100;
    const before = opts.before;
    const located = await this.findSession(id);
    if (!located?.path) return [];

    // Streaming parse with a memory-bounded circular buffer.
    // We never hold more than ~2 * limit parsed entries at once even on a
    // multi-megabyte JSONL.
    const ring: HistoryEntry[] = [];
    const cap = Math.max(limit * 2, limit + 32);
    const stream = createReadStream(located.path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = entryFromRaw(obj);
      if (!parsed) continue;
      for (const e of parsed) {
        if (before && e.timestamp >= before) continue;
        ring.push(e);
        if (ring.length > cap) ring.splice(0, ring.length - limit);
      }
    }
    // Return oldest-first (chronological). Newest is the LAST element — clients
    // that render top-down get a natural chat layout (newest at bottom).
    return ring.length > limit ? ring.slice(-limit) : ring;
  }

  createSession(id: string, cwd: string): AgentSession {
    return new ClaudeCodeSession(id, cwd);
  }
}
