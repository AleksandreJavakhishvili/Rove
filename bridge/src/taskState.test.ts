// Ad-hoc runtime checks for foldTaskState — run with: pnpm exec tsx src/taskState.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldTaskState, foldTaskStateFromTranscript } from './taskState.ts';
import type { HistoryEntry } from './types.ts';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}

let clock = 0;
const ts = () => new Date((clock += 1000)).toISOString();

/** A TaskCreate whose result echoes the harness-assigned `#id` — exactly how
 *  the real transcript looks. The create input deliberately carries NO id. */
function create(useId: string, harnessId: number, subject: string): HistoryEntry[] {
  return [
    { kind: 'tool_use', uuid: useId, parentUuid: null, timestamp: ts(), name: 'TaskCreate', input: { subject }, toolUseId: useId },
    { kind: 'tool_result', uuid: `${useId}:r`, parentUuid: null, timestamp: ts(), toolUseId: useId, content: `Task #${harnessId} created successfully: ${subject}` },
  ];
}
function update(taskId: number, status: string): HistoryEntry {
  return { kind: 'tool_use', uuid: `u${taskId}-${status}`, parentUuid: null, timestamp: ts(), name: 'TaskUpdate', input: { taskId: String(taskId), status }, toolUseId: `u${taskId}-${status}` };
}

function counts(list: { status: string }[]) {
  const c: Record<string, number> = {};
  for (const t of list) c[t.status] = (c[t.status] ?? 0) + 1;
  return c;
}

// 1. The regression: a resumed/compacted window whose batch is #14..#24.
//    Folding by list position would number them 1..11 and the 14..24 updates
//    would all miss, leaving everything `pending` (the "0/11" bug).
{
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < 11; i++) entries.push(...create(`c${14 + i}`, 14 + i, `Task ${14 + i}`));
  for (let i = 14; i <= 23; i++) entries.push(update(i, 'completed')); // 10 completed
  entries.push(update(24, 'deleted')); // 1 deleted -> dropped

  const tasks = foldTaskState(entries);
  const done = tasks.filter((t) => t.status === 'completed').length;
  check('offset window: updates match harness ids (not positional)', done === 10);
  check('offset window: deleted task is dropped', tasks.length === 10);
  check('offset window: no task left stuck pending', !tasks.some((t) => t.status === 'pending'));
  check('offset window: ids are the harness ids', tasks[0]?.id === '14' && tasks[9]?.id === '23');
}

// 2. Non-offset session (ids start at #1) still folds correctly.
{
  const entries: HistoryEntry[] = [];
  for (let i = 1; i <= 3; i++) entries.push(...create(`c${i}`, i, `Task ${i}`));
  entries.push(update(1, 'completed'), update(2, 'in_progress'));
  const tasks = foldTaskState(entries);
  check('from #1: 3 tasks', tasks.length === 3);
  check('from #1: status counts', JSON.stringify(counts(tasks)) === JSON.stringify({ completed: 1, in_progress: 1, pending: 1 }));
}

// 3. Create whose result hasn't landed yet falls back to creation order, and a
//    matching positional update still applies (degraded but not broken).
{
  const entries: HistoryEntry[] = [
    { kind: 'tool_use', uuid: 'c1', parentUuid: null, timestamp: ts(), name: 'TaskCreate', input: { subject: 'pending-result' }, toolUseId: 'c1' },
    update(1, 'in_progress'),
  ];
  const tasks = foldTaskState(entries);
  check('missing result: falls back to seq id and applies update', tasks.length === 1 && tasks[0]?.status === 'in_progress');
}

// 4. TodoWrite path: latest full snapshot wins.
{
  const entries: HistoryEntry[] = [
    { kind: 'tool_use', uuid: 't1', parentUuid: null, timestamp: ts(), name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }, toolUseId: 't1' },
    { kind: 'tool_use', uuid: 't2', parentUuid: null, timestamp: ts(), name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }, toolUseId: 't2' },
  ];
  const tasks = foldTaskState(entries);
  check('TodoWrite: latest snapshot wins', tasks.length === 2 && tasks[0]?.status === 'completed' && tasks[1]?.status === 'in_progress');
}

// 5. Raw-transcript fold: reads the FULL .jsonl from disk (the compaction-proof
//    fallback). Crafts a fixture transcript with a #14-offset batch — the exact
//    shape that the SDK slice would lose — and confirms it folds correctly.
{
  const root = mkdtempSync(join(tmpdir(), 'rove-tasks-'));
  const id = 'sess-abc';
  const slug = '-Users-x-proj';
  mkdirSync(join(root, slug), { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const create = (useId: string, harnessId: number, subject: string) => [
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'TaskCreate', input: { subject } }] } }),
    line({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: `Task #${harnessId} created successfully: ${subject}` }] } }),
  ];
  const upd = (taskId: number, status: string) =>
    line({ type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `u${taskId}${status}`, name: 'TaskUpdate', input: { taskId: String(taskId), status } }] } });
  const lines = [
    line({ type: 'summary', summary: 'noise that must be skipped' }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking…' }] } }),
    ...create('c14', 14, 'Add OTel packages'),
    ...create('c15', 15, 'Wire metrics'),
    ...create('c16', 16, 'Grafana dashboard'),
    upd(14, 'completed'),
    upd(15, 'completed'),
    upd(16, 'in_progress'),
  ];
  writeFileSync(join(root, slug, `${id}.jsonl`), lines.join('\n') + '\n');

  const tasks = await foldTaskStateFromTranscript(root, id);
  const done = tasks.filter((t) => t.status === 'completed').length;
  check('raw fold: finds file + folds full history', tasks.length === 3);
  check('raw fold: harness ids honored across the offset batch', done === 2 && tasks[0]?.id === '14');
  check('raw fold: in_progress carried through', tasks[2]?.status === 'in_progress');

  const missing = await foldTaskStateFromTranscript(root, 'no-such-session');
  check('raw fold: missing transcript -> []', Array.isArray(missing) && missing.length === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
