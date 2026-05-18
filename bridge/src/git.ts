import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

export interface ParsedDiff {
  baseline: string | null;
  files: ParsedDiffFile[];
  raw: string;
}

export interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  hunks: DiffHunk[];
  binary: boolean;
}

export interface DiffHunk {
  header: string;
  lines: DiffHunkLine[];
}

export type DiffHunkLine =
  | { op: 'context'; text: string }
  | { op: 'add'; text: string }
  | { op: 'remove'; text: string };

export async function getHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execP('git rev-parse HEAD', { cwd, timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execP('git rev-parse --is-inside-work-tree', { cwd, timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function getDiff(cwd: string, baseline: string | null): Promise<ParsedDiff> {
  if (!(await isGitRepo(cwd))) {
    return { baseline, files: [], raw: '' };
  }
  // Diff = baseline → working tree (committed + uncommitted). If baseline missing,
  // fall back to current uncommitted changes.
  const base = baseline ?? 'HEAD';
  let raw = '';
  try {
    const { stdout } = await execP(`git diff --no-color --no-prefix ${base}`, {
      cwd,
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024,
    });
    raw = stdout;
  } catch (err) {
    // baseline commit might no longer exist (e.g., new repo, no commits yet).
    // Fall back to diffing against the empty tree.
    try {
      const { stdout } = await execP(`git diff --no-color --no-prefix`, {
        cwd,
        timeout: 10000,
        maxBuffer: 50 * 1024 * 1024,
      });
      raw = stdout;
    } catch {
      raw = '';
    }
  }
  return { baseline, files: parseUnifiedDiff(raw), raw };
}

/**
 * Hand-rolled unified-diff parser. Good enough for the in-app viewer; we
 * specifically don't pull in a heavy parser dependency.
 */
export function parseUnifiedDiff(raw: string): ParsedDiffFile[] {
  if (!raw.trim()) return [];
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const m = line.match(/^diff --git ([^ ]+) ([^ ]+)$/);
      current = {
        oldPath: m?.[1] ?? '',
        newPath: m?.[2] ?? '',
        status: 'modified',
        added: 0,
        removed: 0,
        hunks: [],
        binary: false,
      };
      currentHunk = null;
      i += 1;
      continue;
    }
    if (!current) {
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      i += 1;
      continue;
    }
    if (line.startsWith('rename from')) {
      current.status = 'renamed';
      i += 1;
      continue;
    }
    if (line.startsWith('Binary files')) {
      current.binary = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // Capture cleaner paths.
      if (line.startsWith('--- ')) current.oldPath = line.slice(4);
      if (line.startsWith('+++ ')) current.newPath = line.slice(4);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      currentHunk = { header: line, lines: [] };
      current.hunks.push(currentHunk);
      i += 1;
      continue;
    }
    if (currentHunk) {
      const firstChar = line[0];
      const text = line.slice(1);
      if (firstChar === '+') {
        currentHunk.lines.push({ op: 'add', text });
        current.added += 1;
      } else if (firstChar === '-') {
        currentHunk.lines.push({ op: 'remove', text });
        current.removed += 1;
      } else if (firstChar === ' ') {
        currentHunk.lines.push({ op: 'context', text });
      } else if (firstChar === '\\') {
        // "\ No newline at end of file" — skip.
      } else if (firstChar === undefined) {
        // trailing blank
      }
    }
    i += 1;
  }
  if (current) files.push(current);
  // Strip any prefixes like a/, b/ that survived
  for (const f of files) {
    f.oldPath = f.oldPath.replace(/^a\//, '');
    f.newPath = f.newPath.replace(/^b\//, '');
  }
  return files;
}
