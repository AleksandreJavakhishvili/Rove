import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { SearchHit } from './agents/types.ts';

const execFileP = promisify(execFile);

/** Limit on individual preview lines so the response stays compact when the
 *  match lands in a giant minified file. */
const MAX_PREVIEW_LEN = 240;

/** Refuse to walk files larger than this — matches ripgrep's
 *  `--max-filesize` flag below, applied to the grep fallback manually. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lower / upper bounds the route uses to validate the client-supplied
 *  `limit` query — keep them in sync if either side changes. */
export const SEARCH_LIMIT_DEFAULT = 100;
export const SEARCH_LIMIT_MAX = 500;

export interface SearchOpts {
  /** Literal substring by default; PCRE-lite regex when `regex: true`. */
  query: string;
  /** 1–500. */
  limit?: number;
  regex?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the limit kicked in before the search finished. */
  truncated: boolean;
  /** Which backend was used — useful for the operator-side log on boot. */
  backend: 'ripgrep' | 'grep';
}

let detectedBackend: 'ripgrep' | 'grep' | null = null;

/** Probe for ripgrep on PATH. Cached after the first call. Falls back to
 *  POSIX `grep` (always assumed present on macOS / Linux). */
export async function detectSearchBackend(): Promise<'ripgrep' | 'grep'> {
  if (detectedBackend) return detectedBackend;
  try {
    await execFileP('rg', ['--version'], { timeout: 1500 });
    detectedBackend = 'ripgrep';
  } catch {
    detectedBackend = 'grep';
  }
  return detectedBackend;
}

/**
 * File-contents search scoped to `cwd`. Returns at most `limit` hits.
 *
 * Prefers ripgrep (`rg --json --max-count --max-filesize`) because it
 * respects `.gitignore` and is fast on large trees. Falls back to
 * `grep -RHn` when rg isn't on PATH — functional but slower, with the
 * regex flag downgraded to POSIX BRE.
 */
export async function search(cwd: string, opts: SearchOpts): Promise<SearchResult> {
  const limit = clampLimit(opts.limit);
  const backend = await detectSearchBackend();

  if (backend === 'ripgrep') {
    const hits = await searchRipgrep(cwd, opts, limit);
    return {
      hits: hits.slice(0, limit),
      truncated: hits.length >= limit,
      backend,
    };
  }
  const hits = await searchGrep(cwd, opts, limit);
  return {
    hits: hits.slice(0, limit),
    truncated: hits.length >= limit,
    backend,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.floor(limit));
}

interface RipgrepLine {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{
      match?: { text?: string };
      start?: number;
      end?: number;
    }>;
  };
}

async function searchRipgrep(
  cwd: string,
  opts: SearchOpts,
  limit: number,
): Promise<SearchHit[]> {
  return new Promise((resolveFn, rejectFn) => {
    const args = [
      '--json',
      '--max-count',
      String(limit),
      '--max-filesize',
      String(MAX_FILE_BYTES),
      // Skip hidden files unless the user explicitly opts in later. Keeps
      // the result list focused on source.
      // (rg respects .gitignore by default — no flag needed.)
    ];
    if (!opts.regex) args.push('--fixed-strings');
    args.push('--', opts.query);

    const child = spawn('rg', args, { cwd });
    let buf = '';
    const hits: SearchHit[] = [];
    let stopped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: RipgrepLine;
        try {
          parsed = JSON.parse(line) as RipgrepLine;
        } catch {
          continue;
        }
        if (parsed.type !== 'match' || !parsed.data) continue;
        const path = parsed.data.path?.text ?? '';
        const lineNo = parsed.data.line_number ?? 0;
        const text = parsed.data.lines?.text ?? '';
        const sub = parsed.data.submatches?.[0];
        const startByte = sub?.start ?? 0;
        const endByte = sub?.end ?? startByte;
        const preview = clipPreview(text, startByte, endByte);
        hits.push({
          path,
          line: lineNo,
          column: byteToCol(text, startByte),
          preview: preview.text,
          matchStart: preview.matchStart,
          matchEnd: preview.matchEnd,
        });
        if (hits.length >= limit) {
          stopped = true;
          child.kill('SIGTERM');
          break;
        }
      }
    });
    child.on('error', rejectFn);
    child.on('close', () => resolveFn(hits));
  });
}

/** Trim a preview line to `MAX_PREVIEW_LEN` while keeping the match window
 *  visible. Returns `{ text, matchStart, matchEnd }` with offsets adjusted
 *  to point into the (possibly clipped) text. */
function clipPreview(
  text: string,
  rawStart: number,
  rawEnd: number,
): { text: string; matchStart: number; matchEnd: number } {
  const stripped = text.replace(/\n$/, '');
  if (stripped.length <= MAX_PREVIEW_LEN) {
    return { text: stripped, matchStart: rawStart, matchEnd: rawEnd };
  }
  // Center the match in the clip window; if it's near the start/end of the
  // line, clip from that side.
  const matchLen = Math.max(1, rawEnd - rawStart);
  const half = Math.floor((MAX_PREVIEW_LEN - matchLen) / 2);
  let from = Math.max(0, rawStart - half);
  let to = Math.min(stripped.length, from + MAX_PREVIEW_LEN);
  from = Math.max(0, to - MAX_PREVIEW_LEN);
  const slice = stripped.slice(from, to);
  return {
    text: (from > 0 ? '…' : '') + slice + (to < stripped.length ? '…' : ''),
    matchStart: Math.max(0, rawStart - from) + (from > 0 ? 1 : 0),
    matchEnd: Math.max(0, rawEnd - from) + (from > 0 ? 1 : 0),
  };
}

/** Convert a byte offset (what ripgrep returns) into a UTF-16 column index
 *  the client can use for highlighting. */
function byteToCol(text: string, byteOffset: number): number {
  // Quick path for ASCII — common case.
  if (/^[\x00-\x7f]*$/.test(text.slice(0, byteOffset))) return byteOffset + 1;
  // Walk bytes; count UTF-16 code units.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i + 1;
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // surrogate pair
    } else bytes += 3;
  }
  return text.length + 1;
}

async function searchGrep(
  cwd: string,
  opts: SearchOpts,
  limit: number,
): Promise<SearchHit[]> {
  return new Promise((resolveFn, rejectFn) => {
    // `-RHn`: recursive, always show filename, prefix line number.
    // `-I`: skip binary files. `--exclude-dir=`: a minimum skip list since
    // grep doesn't honor .gitignore.
    const args = [
      '-RHn',
      '-I',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '--exclude-dir=dist',
      '--exclude-dir=build',
      '--exclude-dir=.next',
      '--exclude-dir=.expo',
      '--exclude-dir=.venv',
      '--exclude-dir=__pycache__',
      '-m',
      String(limit),
    ];
    if (opts.regex) args.push('-E');
    else args.push('-F');
    args.push('--', opts.query, '.');

    const child = spawn('grep', args, { cwd });
    let buf = '';
    const hits: SearchHit[] = [];
    let stopped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // grep format: `./path/to/file:LINE:matched line text`
        const m = line.match(/^\.?\/?([^:]+):(\d+):(.*)$/);
        if (!m) continue;
        const path = m[1] ?? '';
        const lineNo = Number.parseInt(m[2] ?? '0', 10);
        const text = m[3] ?? '';
        const idx = opts.regex
          ? 0 // can't trivially locate regex match start without re-running it
          : text.toLowerCase().indexOf(opts.query.toLowerCase());
        const matchStart = Math.max(0, idx);
        const matchEnd = matchStart + opts.query.length;
        const preview = clipPreview(text, matchStart, matchEnd);
        hits.push({
          path,
          line: lineNo,
          column: matchStart + 1,
          preview: preview.text,
          matchStart: preview.matchStart,
          matchEnd: preview.matchEnd,
        });
        if (hits.length >= limit) {
          stopped = true;
          child.kill('SIGTERM');
          break;
        }
      }
    });
    child.on('error', rejectFn);
    child.on('close', () => resolveFn(hits));
  });
}
