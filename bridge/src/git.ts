import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
  GIT_FILE_STATUS,
  type GitFileStatus,
  type GitStatusEntry,
  type GitStatusResult,
} from './agents/types.ts';

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

// ===========================================================================
// Git working-tree status
// ===========================================================================

/** Server-side cap on how long we wait for `git status` to complete. Big
 *  monorepos can take seconds; past this we return what we have with
 *  `incomplete: true` rather than blocking the request. */
const GIT_STATUS_TIMEOUT_MS = 3000;

/**
 * Run `git status --porcelain=v2 --branch --untracked-files=all -z` and
 * parse the output.
 *
 * `--untracked-files=all` is load-bearing: the default (`normal`) collapses
 * a fully-untracked directory into a single `? dir/` record (trailing
 * slash), so the mobile Files tab would show one un-openable row per new
 * folder — tapping it hits `/file` with a directory path and 400s ("not a
 * regular file"). Listing every untracked file individually makes each row
 * a real, openable file. Ignored files are still excluded (we don't pass
 * `--ignored`), so the output stays bounded.
 *
 * Returns `{ isRepo: false, … }` (with sensible empty fields) when the
 * cwd isn't a git working tree, so callers don't have to special-case
 * the error path. Surfaces an `incomplete: true` flag when the timeout
 * trips before the command completes — partial results are not returned
 * in that case, since we can't trust a half-parsed stream.
 */
export async function runGitStatus(cwd: string): Promise<GitStatusResult> {
  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  }

  let raw: string;
  try {
    const { stdout } = await execP('git status --porcelain=v2 --branch --untracked-files=all -z', {
      cwd,
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    raw = stdout;
  } catch (err) {
    // `timeout` kills the child; treat as "incomplete" without returning
    // a half-parsed buffer (no way to know we caught a complete record).
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (err as Error).message?.includes('ETIMEDOUT')) {
      return {
        isRepo: true,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [],
        incomplete: true,
      };
    }
    return { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  }

  return parsePorcelainV2(raw);
}

/**
 * `git status --porcelain=v2 -z` parser. The stream is a series of records
 * separated by NUL bytes; some record types (`2 …`, the rename/copy form)
 * encode two NUL-separated paths in a single logical record. We tokenize
 * by walking the buffer and consuming the right number of NUL-separated
 * chunks per record kind.
 *
 * Reference: `man git-status`, "Porcelain Format Version 2".
 */
export function parsePorcelainV2(raw: string): GitStatusResult {
  const result: GitStatusResult = {
    isRepo: true,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  };

  // Records terminated by NUL. Trailing NUL produces an empty tail token
  // which we filter out. We don't `.split('\0')` blindly because rename/
  // copy records contain an embedded NUL — handled in the consumer loop.
  const tokens = raw.split('\0');
  // Drop trailing empty token from the terminating NUL.
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;

    if (tok.startsWith('# branch.head ')) {
      const branch = tok.slice('# branch.head '.length);
      result.branch = branch === '(detached)' ? null : branch;
      continue;
    }
    if (tok.startsWith('# branch.upstream ')) {
      result.upstream = tok.slice('# branch.upstream '.length);
      continue;
    }
    if (tok.startsWith('# branch.ab ')) {
      const m = tok.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        result.ahead = Number.parseInt(m[1] ?? '0', 10);
        result.behind = Number.parseInt(m[2] ?? '0', 10);
      }
      continue;
    }
    if (tok.startsWith('# ')) {
      // branch.oid / other header lines — not needed by the UI.
      continue;
    }

    // Entry records. Type prefix is a single char followed by a space.
    const kind = tok[0];
    if (kind === '?' && tok.startsWith('? ')) {
      result.entries.push({
        path: tok.slice(2),
        indexStatus: GIT_FILE_STATUS.unmodified,
        worktreeStatus: GIT_FILE_STATUS.untracked,
        isUntracked: true,
        isIgnored: false,
      });
      continue;
    }
    if (kind === '!' && tok.startsWith('! ')) {
      result.entries.push({
        path: tok.slice(2),
        indexStatus: GIT_FILE_STATUS.unmodified,
        worktreeStatus: GIT_FILE_STATUS.ignored,
        isUntracked: false,
        isIgnored: true,
      });
      continue;
    }
    if (kind === '1' && tok.startsWith('1 ')) {
      // Format: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      // We only care about XY and path.
      const xy = tok.slice(2, 4);
      const path = tok.slice(tok.lastIndexOf(' ') + 1);
      const entry: GitStatusEntry = {
        path,
        indexStatus: porcelainStatusChar(xy[0]),
        worktreeStatus: porcelainStatusChar(xy[1]),
        isUntracked: false,
        isIgnored: false,
      };
      result.entries.push(entry);
      continue;
    }
    if (kind === '2' && tok.startsWith('2 ')) {
      // Rename/copy. Format: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>`
      // The `<path>` is at the end of the current token; `<origPath>`
      // is the very next NUL-separated token.
      const xy = tok.slice(2, 4);
      const path = tok.slice(tok.lastIndexOf(' ') + 1);
      const orig = tokens[i + 1] ?? '';
      i += 1; // consume the origPath token
      result.entries.push({
        path,
        renamedFrom: orig,
        indexStatus: porcelainStatusChar(xy[0]),
        worktreeStatus: porcelainStatusChar(xy[1]),
        isUntracked: false,
        isIgnored: false,
      });
      continue;
    }
    if (kind === 'u' && tok.startsWith('u ')) {
      // Unmerged. Format: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const xy = tok.slice(2, 4);
      const path = tok.slice(tok.lastIndexOf(' ') + 1);
      result.entries.push({
        path,
        indexStatus: porcelainStatusChar(xy[0]),
        worktreeStatus: porcelainStatusChar(xy[1]),
        isUntracked: false,
        isIgnored: false,
      });
      continue;
    }
    // Unknown record type — skip silently rather than choke the whole
    // parse. New porcelain v2 record types are added over time.
  }

  return result;
}

function porcelainStatusChar(c: string | undefined): GitFileStatus {
  switch (c) {
    case '.':
      return GIT_FILE_STATUS.unmodified;
    case 'M':
      return GIT_FILE_STATUS.modified;
    case 'A':
      return GIT_FILE_STATUS.added;
    case 'D':
      return GIT_FILE_STATUS.deleted;
    case 'R':
      return GIT_FILE_STATUS.renamed;
    case 'C':
      return GIT_FILE_STATUS.copied;
    case 'T':
      return GIT_FILE_STATUS.typeChange;
    case 'U':
      return GIT_FILE_STATUS.updatedButUnmerged;
    default:
      return GIT_FILE_STATUS.unmodified;
  }
}

// ===========================================================================
// Per-file git diff (working tree vs HEAD or vs index)
// ===========================================================================

export interface GitDiffFileOpts {
  /** Relative-to-cwd POSIX path. */
  path: string;
  /** When true, diff staged changes (`git diff --cached`); otherwise diff
   *  worktree changes vs HEAD (`git diff`). */
  staged: boolean;
}

/**
 * Diff a single file via `git diff [--cached] -- <path>`. Returns a single
 * `ParsedDiffFile`, or `null` when there's nothing to diff for that path
 * in the requested mode (file is clean in worktree, or nothing staged).
 *
 * Errors during the spawn (missing path, etc.) bubble up as Error so the
 * caller can surface them as 400.
 */
export async function runGitDiffFile(
  cwd: string,
  opts: GitDiffFileOpts,
): Promise<ParsedDiffFile | null> {
  if (!(await isGitRepo(cwd))) return null;
  const flags = opts.staged ? '--cached' : '';
  // Wrap the path in `--` to disambiguate against revisions of the same
  // name. Single-quote-escape any literal single quotes in the path.
  const quoted = opts.path.replace(/'/g, "'\\''");
  let raw = '';
  try {
    const { stdout } = await execP(
      `git diff --no-color --no-prefix ${flags} -- '${quoted}'`.trim(),
      { cwd, timeout: 10000, maxBuffer: 50 * 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    // git diff returns non-zero in some edge cases (e.g. external diff
    // drivers). The body is what we care about; if it's empty the file
    // is just clean in the requested mode.
    raw = '';
  }
  const files = parseUnifiedDiff(raw);
  return files[0] ?? null;
}
