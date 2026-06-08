import { existsSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HistoryEntry } from './types.ts';

/**
 * One entry of the agent's current task/progress checklist, normalized
 * across the two tracking tools the agent might use.
 */
export interface TaskState {
  /** Stable id — the harness's sequential "#1".."#N" for Task tools, or the
   *  array index for TodoWrite (which has no id of its own). */
  id: string;
  /** Display text: the Task `subject` or the TodoWrite `content`. */
  content: string;
  /** Present-tense label shown while `in_progress` (both tools provide it). */
  activeForm?: string;
  /** 'pending' | 'in_progress' | 'completed' (and any future status). */
  status: string;
}

interface TodoWriteItem {
  content?: string;
  activeForm?: string;
  status?: string;
}

/** Match the harness's per-task files: `1.json`, `2.json`, … (skips `.lock`). */
const TASK_FILE_RE = /^(\d+)\.json$/;

/**
 * Read the harness's authoritative task store for a session:
 * `<tasksDir>/<sessionId>/<n>.json`, one tiny file per task, updated in place
 * as the agent works. This is what the desktop TUI renders from — cheap
 * (O(#tasks) small reads) and always current, with no transcript scan.
 *
 * Returns null when the session has no task store (e.g. it never used the
 * Task tools, or uses TodoWrite instead) so the caller can fall back to the
 * transcript fold. A malformed individual file is skipped, not fatal.
 */
export async function readSessionTasks(
  tasksDir: string,
  sessionId: string,
): Promise<TaskState[] | null> {
  const dir = join(tasksDir, sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no store for this session
  }
  const numbered = names
    .map((n) => {
      const m = TASK_FILE_RE.exec(n);
      return m ? { name: n, num: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; num: number } => x !== null)
    .sort((a, b) => a.num - b.num);
  if (numbered.length === 0) return null;

  const tasks: TaskState[] = [];
  for (const { name } of numbered) {
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const o = JSON.parse(raw) as {
        id?: string;
        subject?: string;
        activeForm?: string;
        status?: string;
      };
      tasks.push({
        id: typeof o.id === 'string' ? o.id : String(tasks.length + 1),
        content: o.subject ?? '',
        ...(o.activeForm ? { activeForm: o.activeForm } : {}),
        status: typeof o.status === 'string' ? o.status : 'pending',
      });
    } catch {
      // skip an unreadable / half-written file rather than failing the request
    }
  }
  return tasks.length > 0 ? tasks : null;
}

function readTodos(input: unknown): TodoWriteItem[] | null {
  if (input && typeof input === 'object') {
    const todos = (input as { todos?: unknown }).todos;
    if (Array.isArray(todos)) return todos as TodoWriteItem[];
  }
  return null;
}

/** Flatten a tool_result `content` (string, or array of `{type:'text'}`
 *  blocks) down to plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : ((b as { text?: unknown }).text ?? '')))
      .filter((s): s is string => typeof s === 'string')
      .join('');
  }
  return '';
}

/**
 * The harness echoes the id it assigned in the TaskCreate *result*, e.g.
 * `"Task #14 created successfully: …"`. That id — not the task's position in
 * the list — is what every later `TaskUpdate.taskId` references. The create's
 * tool *input* carries no id, so this result string is the only reliable key.
 * Folding by list position breaks the moment the visible window doesn't start
 * at task #1 (e.g. a resumed/compacted session where the current batch is
 * #14..#24): the position-based ids 1..N never match the real 14..N updates,
 * so every task is stuck `pending`.
 */
const TASK_CREATE_ID_RE = /Task #(\d+)/;

/**
 * Reconstruct the current task checklist from a session's full history.
 *
 * Two tools, two strategies:
 *   - `TaskCreate` / `TaskUpdate` (the harness task tools, used by the desktop
 *     CLI): incremental — fold creates into a list (sequential ids matching
 *     the harness's #1..#N) and apply each update by id.
 *   - `TodoWrite` (the SDK's todo tool): every call carries the full snapshot,
 *     so the latest call wins.
 *
 * `entries` must be the FULL history (the bridge's `/git/status`-style routes
 * pass `readHistory` with a high limit) — the default 50-entry replay window
 * cuts off the early `TaskCreate` calls, which is exactly why a phone that
 * only sees the replay can't reconstruct the list itself. Reading the whole
 * transcript via the SDK (`getSessionMessages` under `readHistory`) is the
 * authoritative source; this fold matches the harness's on-disk task files.
 */
export function foldTaskState(entries: HistoryEntry[]): TaskState[] {
  // First pass: TaskCreate tool_use id -> the harness id from its result text.
  const realIdByUse = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'tool_result') continue;
    const m = TASK_CREATE_ID_RE.exec(resultText(e.content));
    if (m) realIdByUse.set(e.toolUseId, m[1]!);
  }

  // Tasks keyed by harness id; Map insertion order = creation order.
  const tasks = new Map<string, TaskState>();
  let latestTodos: TaskState[] | null = null;
  let seq = 0;

  for (const e of entries) {
    if (e.kind !== 'tool_use') continue;
    switch (e.name) {
      case 'TaskCreate': {
        const inp = (e.input ?? {}) as { subject?: string; activeForm?: string; status?: string };
        seq += 1;
        // Prefer the harness-assigned id (from the result); fall back to
        // creation order only when the result isn't available yet (e.g. a
        // just-issued create whose tool_result hasn't landed).
        const id = realIdByUse.get(e.toolUseId) ?? String(seq);
        tasks.set(id, {
          id,
          content: inp.subject ?? '',
          ...(inp.activeForm ? { activeForm: inp.activeForm } : {}),
          status: typeof inp.status === 'string' ? inp.status : 'pending',
        });
        break;
      }
      case 'TaskUpdate': {
        const inp = (e.input ?? {}) as { taskId?: string | number; status?: string; subject?: string };
        const target = tasks.get(String(inp.taskId));
        if (target) {
          if (typeof inp.status === 'string') target.status = inp.status;
          if (typeof inp.subject === 'string') target.content = inp.subject;
        }
        break;
      }
      case 'TodoWrite': {
        const todos = readTodos(e.input);
        if (todos) {
          latestTodos = todos.map((td, i) => ({
            id: String(i + 1),
            content: td.content ?? '',
            ...(td.activeForm ? { activeForm: td.activeForm } : {}),
            status: typeof td.status === 'string' ? td.status : 'pending',
          }));
        }
        break;
      }
    }
  }

  // Prefer the harness Task checklist when present; else the latest TodoWrite.
  // Drop tasks the agent deleted — the desktop TUI hides them too.
  if (tasks.size > 0) {
    return [...tasks.values()].filter((t) => t.status !== 'deleted');
  }
  return latestTodos ?? [];
}

/** Locate a session's raw transcript: `<projectsDir>/<slug>/<sessionId>.jsonl`.
 *  The slug encodes the cwd, so we scan project dirs for the id rather than
 *  reconstruct it. */
function findTranscriptPath(projectsDir: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extract only the task-relevant entries (TaskCreate/Update/List tool_use +
 *  tool_result, TodoWrite) from one raw JSONL line. Mirrors the wire shape
 *  `foldTaskState` consumes; everything else is ignored. */
function transcriptLineToTaskEntries(obj: unknown): HistoryEntry[] {
  const o = (obj ?? {}) as { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
  const ts = typeof o.timestamp === 'string' ? o.timestamp : '';
  const content = o.message?.content;
  if (!Array.isArray(content)) return [];
  const out: HistoryEntry[] = [];
  if (o.type === 'assistant' && o.message?.role === 'assistant') {
    for (const b of content as Array<Record<string, unknown>>) {
      if (
        b.type === 'tool_use' &&
        (b.name === 'TaskCreate' || b.name === 'TaskUpdate' || b.name === 'TaskList' || b.name === 'TodoWrite')
      ) {
        out.push({
          kind: 'tool_use',
          uuid: String(b.id),
          parentUuid: null,
          timestamp: ts,
          name: String(b.name),
          input: b.input,
          toolUseId: String(b.id),
        });
      }
    }
  } else if (o.type === 'user' && o.message?.role === 'user') {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result') {
        out.push({
          kind: 'tool_result',
          uuid: `${String(b.tool_use_id)}:r`,
          parentUuid: null,
          timestamp: ts,
          toolUseId: String(b.tool_use_id),
          content: b.content,
        });
      }
    }
  }
  return out;
}

/**
 * Fold task state straight from a session's raw JSONL transcript (the FULL
 * history). The SDK's `getSessionMessages` only returns the active
 * post-compaction conversation chain, so when an agent's task batch predates
 * the last compaction boundary the SDK-based fold comes back empty and the
 * panel vanishes — even though the checklist still exists on disk. This reads
 * the file directly so the tasks survive compaction. Cheap line pre-filter
 * keeps it fast on multi-MB transcripts; returns [] if the file is missing.
 */
export async function foldTaskStateFromTranscript(
  projectsDir: string,
  sessionId: string,
): Promise<TaskState[]> {
  const path = findTranscriptPath(projectsDir, sessionId);
  if (!path) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    // Only task tool calls and their results carry "Task"/"Todo"; skip the
    // rest without paying for a JSON.parse.
    if (!line.includes('Task') && !line.includes('Todo')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of transcriptLineToTaskEntries(obj)) entries.push(e);
  }
  return foldTaskState(entries);
}
