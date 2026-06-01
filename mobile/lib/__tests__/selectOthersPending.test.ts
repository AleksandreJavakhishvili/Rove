import { selectOthersPending, type PendingMap } from '../pendingSelectors';
import type { PendingPermissionSnapshot } from '../bridge';

function snap(
  agent: string,
  sessionId: string,
  toolUseId: string,
  createdAt: number,
): PendingPermissionSnapshot {
  return { agent, sessionId, toolUseId, tool: 'Bash', input: {}, cwd: null, createdAt };
}

describe('selectOthersPending', () => {
  it('excludes the focused session', () => {
    const byKey: PendingMap = {
      'claude-code:A': [snap('claude-code', 'A', 't1', 1)],
      'claude-code:B': [snap('claude-code', 'B', 't2', 2)],
    };
    const others = selectOthersPending(byKey, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId)).toEqual(['t2']);
  });

  it('includes every non-focused session, flattened', () => {
    const byKey: PendingMap = {
      'claude-code:A': [snap('claude-code', 'A', 't1', 1)],
      'claude-code:B': [snap('claude-code', 'B', 't2', 2), snap('claude-code', 'B', 't3', 3)],
      'codex:C': [snap('codex', 'C', 't4', 4)],
    };
    const others = selectOthersPending(byKey, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId).sort()).toEqual(['t2', 't3', 't4']);
  });

  it('sorts oldest-first by createdAt across sessions', () => {
    const byKey: PendingMap = {
      'codex:C': [snap('codex', 'C', 'late', 30)],
      'claude-code:B': [snap('claude-code', 'B', 'early', 10), snap('claude-code', 'B', 'mid', 20)],
    };
    const others = selectOthersPending(byKey, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId)).toEqual(['early', 'mid', 'late']);
  });

  it('returns empty when only the focused session is pending', () => {
    const byKey: PendingMap = {
      'claude-code:A': [snap('claude-code', 'A', 't1', 1)],
    };
    expect(selectOthersPending(byKey, 'claude-code', 'A')).toEqual([]);
  });

  it('does not collide across agents that share a sessionId', () => {
    // Same sessionId "X" under two different agents must remain distinct: only
    // the focused agent:session key is excluded.
    const byKey: PendingMap = {
      'claude-code:X': [snap('claude-code', 'X', 'focused', 1)],
      'codex:X': [snap('codex', 'X', 'other', 2)],
    };
    const others = selectOthersPending(byKey, 'claude-code', 'X');
    expect(others.map((p) => p.toolUseId)).toEqual(['other']);
  });
});
