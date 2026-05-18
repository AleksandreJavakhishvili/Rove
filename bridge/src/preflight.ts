import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

/** Best-effort check of the current process's open-file-descriptor limit. */
async function getFdLimit(): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    // Run `ulimit -n` in a sub-shell — POSIX-only built-in, so we go through sh.
    const { stdout } = await execP('sh -c "ulimit -n"', { timeout: 1000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Runs once at startup. Prints warnings (and remediation) for known footguns:
 * - macOS default 256 file descriptors (causes spawn EBADF when chokidar watches a big repo).
 * - `claude` binary not on PATH.
 */
export async function preflight(claudeBin: string): Promise<void> {
  const limit = await getFdLimit();
  if (limit !== null && limit < 4096) {
    console.log('━'.repeat(60));
    console.log(`[preflight] FD limit is low: ulimit -n = ${limit}`);
    console.log('  Chokidar + Node spawn will hit EBADF on bigger projects.');
    console.log('  Fix in this shell:');
    console.log('    ulimit -n 8192');
    console.log('  Permanent (zsh): add the same line to ~/.zshrc');
    console.log('━'.repeat(60));
  }
  // Probe claude binary
  try {
    await execP(`command -v ${claudeBin}`, { timeout: 1000 });
  } catch {
    console.log('━'.repeat(60));
    console.log(`[preflight] '${claudeBin}' not found on PATH.`);
    console.log('  Install: npm i -g @anthropic-ai/claude-code');
    console.log('  Then: claude /login');
    console.log('━'.repeat(60));
  }
}
