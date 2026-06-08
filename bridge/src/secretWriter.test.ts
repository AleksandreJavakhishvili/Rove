// Ad-hoc runtime checks for secretWriter — run with: pnpm exec tsx src/secretWriter.test.ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretWriteError, writeDotenvSecret } from './secretWriter.ts';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rove-secret-'));
}

// 1. Fresh .env create + gitignore created
{
  const cwd = tmp();
  const res = writeDotenvSecret(cwd, '.env', 'OPENAI_API_KEY', 'sk-abc123');
  const env = readFileSync(join(cwd, '.env'), 'utf8');
  check('fresh: writes NAME=value', env.includes('OPENAI_API_KEY=sk-abc123'));
  check('fresh: where is .env', res.where === '.env');
  check('fresh: gitignore added', res.addedGitignore === true);
  check('fresh: .gitignore lists .env', readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n').includes('.env'));
  rmSync(cwd, { recursive: true, force: true });
}

// 2. Upsert existing key, preserve siblings
{
  const cwd = tmp();
  writeFileSync(join(cwd, '.env'), 'FOO=1\nOPENAI_API_KEY=old\nBAR=2\n');
  writeDotenvSecret(cwd, '.env', 'OPENAI_API_KEY', 'new');
  const env = readFileSync(join(cwd, '.env'), 'utf8');
  check('upsert: replaces value', env.includes('OPENAI_API_KEY=new') && !env.includes('=old'));
  check('upsert: preserves FOO', env.includes('FOO=1'));
  check('upsert: preserves BAR', env.includes('BAR=2'));
  check('upsert: no duplicate key', (env.match(/OPENAI_API_KEY=/g) ?? []).length === 1);
  rmSync(cwd, { recursive: true, force: true });
}

// 3. Path traversal rejected
{
  const cwd = tmp();
  let threw: SecretWriteError | null = null;
  try {
    writeDotenvSecret(cwd, '../escape.env', 'X', 'v');
  } catch (e) {
    threw = e as SecretWriteError;
  }
  check('traversal: throws path_outside_cwd', threw?.code === 'path_outside_cwd');
  check('traversal: nothing written outside', !existsSync(join(cwd, '..', 'escape.env')));
  rmSync(cwd, { recursive: true, force: true });
}

// 4. Absolute path rejected
{
  const cwd = tmp();
  let threw: SecretWriteError | null = null;
  try {
    writeDotenvSecret(cwd, '/tmp/abs.env', 'X', 'v');
  } catch (e) {
    threw = e as SecretWriteError;
  }
  check('absolute: throws path_outside_cwd', threw?.code === 'path_outside_cwd');
  rmSync(cwd, { recursive: true, force: true });
}

// 5. Invalid name rejected
{
  const cwd = tmp();
  let threw: SecretWriteError | null = null;
  try {
    writeDotenvSecret(cwd, '.env', '1BAD NAME', 'v');
  } catch (e) {
    threw = e as SecretWriteError;
  }
  check('name: throws invalid_name', threw?.code === 'invalid_name');
  rmSync(cwd, { recursive: true, force: true });
}

// 6. Special-char value gets quoted + round-trips on one line
{
  const cwd = tmp();
  writeDotenvSecret(cwd, '.env', 'DATABASE_URL', 'postgres://u:p w@h/db?x=1');
  const env = readFileSync(join(cwd, '.env'), 'utf8').trim();
  check('quote: single line', env.split('\n').length === 1);
  check('quote: double-quoted', env.startsWith('DATABASE_URL="') && env.endsWith('"'));
  rmSync(cwd, { recursive: true, force: true });
}

// 7. Already-gitignored → addedGitignore false; nested path
{
  const cwd = tmp();
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n.env\n');
  const res = writeDotenvSecret(cwd, '.env', 'A', 'b');
  check('gitignore: not re-added when present', res.addedGitignore === false && res.gitignored === true);
  rmSync(cwd, { recursive: true, force: true });
}

// 8. Subdir path inside cwd is allowed + dirs created
{
  const cwd = tmp();
  const res = writeDotenvSecret(cwd, 'backend/.env', 'KEY', 'val');
  check('subdir: writes nested file', readFileSync(join(cwd, 'backend', '.env'), 'utf8').includes('KEY=val'));
  check('subdir: where is backend/.env', res.where === join('backend', '.env'));
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
