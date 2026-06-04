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
  const tasks: TaskState[] = [];
  let latestTodos: TaskState[] | null = null;

  for (const e of entries) {
    if (e.kind !== 'tool_use') continue;
    switch (e.name) {
      case 'TaskCreate': {
        const inp = (e.input ?? {}) as { subject?: string; activeForm?: string; status?: string };
        tasks.push({
          id: String(tasks.length + 1),
          content: inp.subject ?? '',
          ...(inp.activeForm ? { activeForm: inp.activeForm } : {}),
          status: typeof inp.status === 'string' ? inp.status : 'pending',
        });
        break;
      }
      case 'TaskUpdate': {
        const inp = (e.input ?? {}) as { taskId?: string | number; status?: string; subject?: string };
        const target = tasks.find((t) => t.id === String(inp.taskId));
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
  if (tasks.length > 0) return tasks;
  return latestTodos ?? [];
}
