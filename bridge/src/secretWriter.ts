import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Write-through secret materialization for the Rove Secrets SDD
 * (`docs/sdd/2026-06-07-rove-secrets/`).
 *
 * The bridge — never the agent — writes a pasted credential into a file
 * (default `.env`) the agent named. The value is passed in as an
 * argument, written, and dropped; this module keeps NO copy. The model
 * never receives the value (it only ever asked for a name + a path).
 *
 * Two safety guarantees live here:
 *   1. Path confinement — the destination must resolve inside the
 *      session cwd. The model picks the path, so this is the only thing
 *      between it and writing a secret somewhere surprising.
 *   2. Gitignore safety — the destination is ensured-ignored before we
 *      hand control back, so a freshly-created `.env` can't be committed.
 */

export type SecretWriteErrorCode = 'path_outside_cwd' | 'invalid_name' | 'write_failed';

export class SecretWriteError extends Error {
  constructor(
    public readonly code: SecretWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretWriteError';
  }
}

export interface SecretWriteResult {
  /** Path actually written, relative to cwd (e.g. `.env`). */
  where: string;
  /** Whether the destination is now ignored by git (always true on success). */
  gitignored: boolean;
  /** Whether we had to append an entry to `.gitignore` this call. */
  addedGitignore: boolean;
}

/** dotenv keys are POSIX env-var names: letters/underscore, then word chars. */
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Upsert `NAME=value` into `<cwd>/<rawPath>` (creating the file/dirs if
 * needed), then ensure the file is gitignored. Throws {@link SecretWriteError}
 * on a bad name, an out-of-cwd path, or a filesystem failure — the caller
 * surfaces these to the agent as a value-free `error:` result.
 */
export function writeDotenvSecret(
  cwd: string,
  rawPath: string,
  name: string,
  value: string,
): SecretWriteResult {
  if (!VALID_ENV_NAME.test(name)) {
    throw new SecretWriteError(
      'invalid_name',
      `Invalid environment variable name "${name}" — use letters, digits, and underscores, not starting with a digit.`,
    );
  }

  const target = resolve(cwd, rawPath);
  const rel = relative(cwd, target);
  // `rel === ''` → the path resolved to cwd itself (a directory, not a file).
  // A leading `..` or an absolute `rel` → the path escaped the project root.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SecretWriteError(
      'path_outside_cwd',
      `Destination "${rawPath}" is outside the project directory; refusing to write.`,
    );
  }

  try {
    upsertDotenv(target, name, value);
  } catch (err) {
    throw new SecretWriteError('write_failed', String((err as Error).message ?? err));
  }

  const { added } = ensureGitignored(cwd, rel);
  return { where: rel, gitignored: true, addedGitignore: added };
}

/** Replace an existing `NAME=…` line in place, else append one. */
function upsertDotenv(file: string, name: string, value: string): void {
  const assignment = `${name}=${formatDotenvValue(value)}`;
  let content = '';
  if (existsSync(file)) {
    content = readFileSync(file, 'utf8');
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }

  // Match `NAME=…` at line start, tolerating leading whitespace and an
  // optional `export `. `.` doesn't cross newlines (no `s` flag), so this
  // only ever rewrites a single line.
  const re = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${escapeRegExp(name)}[ \\t]*=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, assignment);
  } else {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += `${assignment}\n`;
  }

  // 0o600 applies on create; existing files keep their perms (the user's choice).
  writeFileSync(file, content, { mode: 0o600 });
}

/**
 * Best-effort dotenv value formatting. Bare for the common case (API keys
 * are `[A-Za-z0-9_\-.]+`); double-quoted + escaped when the value contains
 * whitespace or shell-significant characters so it round-trips through
 * standard dotenv parsers. Newlines are escaped to keep the assignment on
 * one line.
 */
function formatDotenvValue(value: string): string {
  if (value !== '' && !/[\s#"'`$\\=]/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Ensure `<cwd>/.gitignore` ignores `relPath`. Best-effort string match
 * (doesn't evaluate glob rules like `*.env`); a redundant entry when a
 * glob already covers it is harmless. Appends `relPath` if no exact line
 * for it exists.
 */
function ensureGitignored(cwd: string, relPath: string): { added: boolean } {
  const giPath = resolve(cwd, '.gitignore');
  const normalized = relPath.split('\\').join('/');
  const candidates = new Set([normalized, `/${normalized}`]);

  const current = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (current.length > 0) {
    const lines = current.split('\n').map((l) => l.trim());
    if (lines.some((l) => candidates.has(l))) return { added: false };
  }

  // Append, guaranteeing a leading newline if the file lacks a trailing one.
  const toAppend = `${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${normalized}\n`;
  appendFileSync(giPath, toAppend);
  return { added: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
