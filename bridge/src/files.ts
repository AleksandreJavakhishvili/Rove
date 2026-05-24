import { stat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface FileRead {
  path: string;
  size: number;
  truncated: boolean;
  contents: string;
}

/**
 * Read a file scoped to `cwd`. Resolves the requested path relative to cwd,
 * then enforces the result is still inside cwd (path-traversal guard). Caps
 * at maxBytes so the phone never has to handle a 50MB download by accident.
 */
export async function readScopedFile(cwd: string, relOrAbs: string, maxBytes = 512 * 1024): Promise<FileRead> {
  const requested = resolve(cwd, relOrAbs);
  const cwdResolved = resolve(cwd);
  const within = requested === cwdResolved || requested.startsWith(cwdResolved + sep);
  if (!within) throw new Error('path escapes session cwd');

  const st = await stat(requested);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > maxBytes) {
    const fh = await readFile(requested, { encoding: 'utf8' });
    return { path: requested, size: st.size, truncated: true, contents: fh.slice(0, maxBytes) };
  }
  const data = await readFile(requested, { encoding: 'utf8' });
  return { path: requested, size: st.size, truncated: false, contents: data };
}

/**
 * Make a path display-friendly: drop the cwd prefix when present.
 */
export function relToCwd(cwd: string, path: string): string {
  const c = resolve(cwd);
  const p = resolve(path);
  if (p === c) return '';
  if (p.startsWith(c + sep)) return p.slice(c.length + 1);
  return p;
}

/**
 * Validate a client-supplied relative path used as a query parameter (the
 * per-file diff route, git diff route, search jump targets, …). Strips
 * leading slashes, normalizes backslashes to forward slashes, and rejects
 * any `..` traversal segment. Throws on invalid input so the route layer
 * can surface a 400 with the error message.
 *
 * Returns the empty string for an empty / `.` input — callers that need
 * to require a non-empty path must check for that themselves.
 */
export function normalizeClientRelPath(input: string): string {
  const trimmed = input.trim().replace(/^[/\\]+/, '');
  if (trimmed === '' || trimmed === '.') return '';
  const segments = trimmed.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === '..') throw new Error('relative path contains traversal segment');
    if (seg === '.') throw new Error('relative path contains . segment');
  }
  return segments.join('/');
}
