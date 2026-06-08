// Ad-hoc runtime checks for secretBroker — run with: pnpm exec tsx src/secretBroker.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelSecretsForSession,
  denySecret,
  pendingSecretCount,
  provideSecret,
  requestSecret,
  type SecretOutcome,
} from './secretBroker.ts';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'rove-broker-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The broker's timers are unref()'d (so a stuck request can't keep the
  // real bridge process alive). In this standalone script nothing else
  // holds the event loop open, so a ref'd keep-alive is needed for the
  // timeout test to actually fire instead of the process exiting first.
  const keepAlive = setInterval(() => {}, 1000);

  // 1. provide → writes file, resolves value-free
  {
    const cwd = tmp();
    const calls: Array<{ requestId: string; name: string; reason: string; path: string }> = [];
    const p = requestSecret(
      'sess-1',
      { cwd, name: 'OPENAI_API_KEY', reason: 'tests' },
      (args) => {
        calls.push(args);
      },
    );
    check(
      'provide: dispatch called with name/path',
      calls.length === 1 && calls[0]?.name === 'OPENAI_API_KEY' && calls[0]?.path === '.env',
    );
    check('provide: pending registered', pendingSecretCount() === 1);
    provideSecret(calls[0]!.requestId, 'sk-secret-123');
    const outcome = (await p) as SecretOutcome;
    check('provide: outcome ok', outcome.ok === true);
    check('provide: outcome carries NO value', !JSON.stringify(outcome).includes('sk-secret-123'));
    check('provide: file has value', readFileSync(join(cwd, '.env'), 'utf8').includes('OPENAI_API_KEY=sk-secret-123'));
    check('provide: pending drained', pendingSecretCount() === 0);
    rmSync(cwd, { recursive: true, force: true });
  }

  // 2. user-edited path override is honored
  {
    const cwd = tmp();
    let id = '';
    const p = requestSecret('sess-2', { cwd, name: 'X', reason: 'r', path: '.env' }, (a) => (id = a.requestId));
    provideSecret(id, 'v', 'backend/.env');
    const outcome = await p;
    check('override: writes to edited path', outcome.ok === true && outcome.where === join('backend', '.env'));
    rmSync(cwd, { recursive: true, force: true });
  }

  // 3. deny → non-fatal denied outcome
  {
    const cwd = tmp();
    let id = '';
    const p = requestSecret('sess-3', { cwd, name: 'Y', reason: 'r' }, (a) => (id = a.requestId));
    denySecret(id);
    const outcome = await p;
    check('deny: status denied', outcome.ok === false && outcome.status === 'denied');
    rmSync(cwd, { recursive: true, force: true });
  }

  // 4. dispatch throws (no client) → no_client
  {
    const cwd = tmp();
    const outcome = await requestSecret('sess-4', { cwd, name: 'Z', reason: 'r' }, () => {
      throw new Error('no socket');
    });
    check('no_client: status no_client', outcome.ok === false && outcome.status === 'no_client');
    rmSync(cwd, { recursive: true, force: true });
  }

  // 5. timeout → timeout outcome
  {
    const cwd = tmp();
    const outcome = await requestSecret('sess-5', { cwd, name: 'T', reason: 'r', timeoutMs: 30 }, () => {});
    check('timeout: status timeout', outcome.ok === false && outcome.status === 'timeout');
    rmSync(cwd, { recursive: true, force: true });
  }

  // 6. cancel-for-session drains pending as cancelled
  {
    const cwd = tmp();
    const p = requestSecret('sess-6', { cwd, name: 'C', reason: 'r' }, () => {});
    cancelSecretsForSession('sess-6');
    const outcome = await p;
    check('cancel: status cancelled', outcome.ok === false && outcome.status === 'cancelled');
    rmSync(cwd, { recursive: true, force: true });
  }

  // 7. write error (bad path) → error outcome, never throws
  {
    const cwd = tmp();
    let id = '';
    const p = requestSecret('sess-7', { cwd, name: 'E', reason: 'r', path: '../escape' }, (a) => (id = a.requestId));
    provideSecret(id, 'v');
    const outcome = await p;
    check('error: status error on bad path', outcome.ok === false && outcome.status === 'error');
    rmSync(cwd, { recursive: true, force: true });
  }

  await sleep(50);
  clearInterval(keepAlive);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
