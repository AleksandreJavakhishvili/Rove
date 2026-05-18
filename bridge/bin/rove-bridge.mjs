#!/usr/bin/env node
// Thin CLI entry. Re-execs `tsx src/server.ts` from the package root, and
// raises the FD limit on POSIX systems first.
//
// When the package is npm-installed globally as `rove-bridge`, this is
// the binary the user actually runs.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const serverPath = join(pkgRoot, 'src', 'server.ts');

// Find tsx binary inside our own node_modules (works when installed globally
// or pnpm-linked) before falling back to PATH.
const tsxLocal = join(pkgRoot, 'node_modules', '.bin', 'tsx');
const tsx = await (async () => {
  try {
    const { existsSync } = await import('node:fs');
    return existsSync(tsxLocal) ? tsxLocal : 'tsx';
  } catch {
    return 'tsx';
  }
})();

// Best-effort ulimit raise via shell wrapper (POSIX only).
const isPosix = process.platform !== 'win32';
const cmd = isPosix ? 'sh' : tsx;
const args = isPosix
  ? ['-c', `ulimit -n 8192 2>/dev/null; exec "${tsx}" "${serverPath}" "$@"`, 'rove-bridge', ...process.argv.slice(2)]
  : [serverPath, ...process.argv.slice(2)];

const child = spawn(cmd, args, { stdio: 'inherit', cwd: pkgRoot });
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
