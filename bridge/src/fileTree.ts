import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, posix, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

import { TREE_ENTRY_KIND, type TreeEntry } from './agents/types.ts';

/**
 * Directories the tree endpoint never enters regardless of `.gitignore`.
 * Universal noise — every project has them, no user benefit from listing
 * their contents. If this list proves wrong we add a config flag, but the
 * default needs to stay tight so the @-mention picker corpus is usable.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.expo',
  '.expo-shared',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.pnpm-store',
  '.gradle',
  '.idea',
  '.vscode',
  'target', // rust
]);

/** Hard cap on entries returned by a single tree call. Prevents a depth=4
 *  call against a huge monorepo from streaming 100k rows into the phone. */
const MAX_ENTRIES = 10_000;

/** Hard cap on `depth` requested by the client. depth=4 already gives the
 *  picker enough breadth; deeper requests are a smell. */
const MAX_DEPTH = 4;

export interface ListDirectoryOpts {
  /** Relative-to-cwd POSIX path. `''` (default) means cwd itself. */
  path?: string;
  /** How many levels to descend; capped at MAX_DEPTH. */
  depth?: number;
  /** Include dotfiles in the result (still flagged `hidden: true`). */
  includeHidden?: boolean;
  /** Include `.gitignore`-matched entries (still flagged `gitIgnored: true`). */
  includeIgnored?: boolean;
}

export interface ListDirectoryResult {
  /** Echoed relative path the caller asked for. */
  root: string;
  entries: TreeEntry[];
  /** True when the MAX_ENTRIES cap kicked in before we finished walking. */
  truncated: boolean;
}

/**
 * Walk `cwd`/`opts.path` up to `opts.depth` levels deep, returning every
 * file/dir/symlink as a flat list with paths relative to `cwd`. Honors a
 * built-in skip list (node_modules / .git / etc.) and (optionally) the
 * project's `.gitignore`.
 *
 * Path-scoping: the resolved start directory must equal `cwd` or live
 * underneath it after realpath resolution; symlinks pointing outside the
 * sandbox are surfaced as `kind: 'symlink'` but not descended into. The
 * route layer rejects an out-of-sandbox start path with 400 before we get
 * here, but we double-check anyway.
 */
export async function listDirectory(
  cwd: string,
  opts: ListDirectoryOpts = {},
): Promise<ListDirectoryResult> {
  const requestedRel = normalizeRelPath(opts.path ?? '');
  const depth = clampDepth(opts.depth ?? 1);

  const cwdReal = await realpath(resolve(cwd));
  const startAbs = requestedRel === '' ? cwdReal : resolve(cwdReal, requestedRel);
  const startReal = await realpath(startAbs);
  if (!isWithin(startReal, cwdReal)) {
    throw new Error('path escapes session cwd');
  }
  const startStat = await stat(startReal);
  if (!startStat.isDirectory()) {
    throw new Error('not a directory');
  }

  const entries: TreeEntry[] = [];
  let truncated = false;

  // Walk breadth-first so depth limit semantics are obvious. Each queue
  // item carries its depth so we don't recurse past the cap.
  const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
    { absDir: startReal, relDir: requestedRel, depth: 0 },
  ];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { absDir, relDir, depth: d } = next;
    if (d >= depth) continue;

    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      // Unreadable dir (permissions, race with deletion) — skip silently.
      continue;
    }

    // Sort once per directory so the response is deterministic and the
    // picker's "first 30 results" feels stable across reloads.
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    let ignoredSet: ReadonlySet<string> = new Set();
    if (!opts.includeIgnored) {
      ignoredSet = await gitCheckIgnoreBatch(
        cwdReal,
        dirents.map((d2) => join(absDir, d2.name)),
      );
    }

    for (const d2 of dirents) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (SKIP_DIRS.has(d2.name)) continue;

      const hidden = d2.name.startsWith('.');
      if (hidden && !opts.includeHidden) continue;

      const abs = join(absDir, d2.name);
      const rel = relDir === '' ? d2.name : posix.join(relDir, d2.name);
      const ignored = ignoredSet.has(abs);
      if (ignored && !opts.includeIgnored) continue;

      const kind = direntKind(d2);
      const entry: TreeEntry = {
        name: d2.name,
        path: rel,
        kind,
        ...(hidden ? { hidden: true } : {}),
        ...(ignored ? { gitIgnored: true } : {}),
      };

      // Best-effort metadata; failures (broken symlink, race) are non-fatal.
      try {
        const st = await stat(abs);
        if (st.isFile()) entry.size = st.size;
        entry.modifiedMs = st.mtimeMs;
      } catch {
        /* swallow */
      }

      entries.push(entry);

      if (kind === TREE_ENTRY_KIND.dir && d + 1 < depth) {
        // Only recurse into directories that actually live inside the
        // sandbox — protects against symlinked dirs pointing outside.
        let descendAbs: string;
        try {
          descendAbs = await realpath(abs);
        } catch {
          continue;
        }
        if (isWithin(descendAbs, cwdReal)) {
          queue.push({ absDir: descendAbs, relDir: rel, depth: d + 1 });
        }
      }
    }
    if (truncated) break;
  }

  return { root: requestedRel, entries, truncated };
}

function direntKind(d: import('node:fs').Dirent): TreeEntry['kind'] {
  if (d.isSymbolicLink()) return TREE_ENTRY_KIND.symlink;
  if (d.isDirectory()) return TREE_ENTRY_KIND.dir;
  return TREE_ENTRY_KIND.file;
}

function clampDepth(d: number): number {
  if (!Number.isFinite(d) || d < 1) return 1;
  return Math.min(MAX_DEPTH, Math.floor(d));
}

/** Reject `..` traversal up front so the realpath-based sandbox check is a
 *  belt-and-braces guarantee, not the only line of defense. */
function normalizeRelPath(rel: string): string {
  const trimmed = rel.trim().replace(/^[/\\]+/, '');
  if (trimmed === '' || trimmed === '.') return '';
  const segments = trimmed.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error('relative path contains traversal segments');
    }
  }
  return segments.join(posix.sep);
}

function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

/**
 * Batched `git check-ignore --stdin` — one fork per directory instead of one
 * per file. Returns the set of absolute paths git would ignore. When the cwd
 * isn't a git repo (or git isn't available), returns an empty set so the
 * caller's "ignored?" check is a no-op rather than an error path.
 */
async function gitCheckIgnoreBatch(
  cwd: string,
  absPaths: string[],
): Promise<ReadonlySet<string>> {
  if (absPaths.length === 0) return new Set();
  return new Promise((resolveFn) => {
    let child;
    try {
      child = spawn('git', ['check-ignore', '--stdin', '-z'], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolveFn(new Set());
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolveFn(new Set()));
    child.on('close', (code) => {
      // git check-ignore exits 0 when matches, 1 when none, other codes mean
      // git unavailable / not a repo — all of which are "treat as empty."
      if (code !== 0 && code !== 1) {
        resolveFn(new Set());
        return;
      }
      const matched = out.split('\0').filter(Boolean);
      const byAbs = new Set<string>();
      for (const m of matched) {
        // git returns paths relative to its cwd; resolve back to absolute so
        // the caller's lookup matches the keys it asked about.
        byAbs.add(resolve(cwd, m));
      }
      resolveFn(byAbs);
    });
    try {
      child.stdin?.end(absPaths.join('\0') + '\0');
    } catch {
      resolveFn(new Set());
    }
  });
}

/** Exposed for tests / debugging — derive the human display name of a path
 *  (basename), used by the picker for ranking. */
export function entryBasename(path: string): string {
  return basename(path);
}
