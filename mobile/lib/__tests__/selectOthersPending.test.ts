import { selectOthersPending, type PendingItem, type PendingMap } from '../pendingSelectors';

function snap(
  bridgeId: string,
  agent: string,
  sessionId: string,
  toolUseId: string,
  createdAt: number,
): PendingItem {
  return { bridgeId, agent, sessionId, toolUseId, tool: 'Bash', input: {}, cwd: null, createdAt };
}

const B = 'b1';

describe('selectOthersPending', () => {
  it('excludes the focused session', () => {
    const byKey: PendingMap = {
      [`${B}:claude-code:A`]: [snap(B, 'claude-code', 'A', 't1', 1)],
      [`${B}:claude-code:B`]: [snap(B, 'claude-code', 'B', 't2', 2)],
    };
    const others = selectOthersPending(byKey, B, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId)).toEqual(['t2']);
  });

  it('includes every non-focused session, flattened', () => {
    const byKey: PendingMap = {
      [`${B}:claude-code:A`]: [snap(B, 'claude-code', 'A', 't1', 1)],
      [`${B}:claude-code:B`]: [
        snap(B, 'claude-code', 'B', 't2', 2),
        snap(B, 'claude-code', 'B', 't3', 3),
      ],
      [`${B}:codex:C`]: [snap(B, 'codex', 'C', 't4', 4)],
    };
    const others = selectOthersPending(byKey, B, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId).sort()).toEqual(['t2', 't3', 't4']);
  });

  it('sorts oldest-first by createdAt across sessions', () => {
    const byKey: PendingMap = {
      [`${B}:codex:C`]: [snap(B, 'codex', 'C', 'late', 30)],
      [`${B}:claude-code:B`]: [
        snap(B, 'claude-code', 'B', 'early', 10),
        snap(B, 'claude-code', 'B', 'mid', 20),
      ],
    };
    const others = selectOthersPending(byKey, B, 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId)).toEqual(['early', 'mid', 'late']);
  });

  it('returns empty when only the focused session is pending', () => {
    const byKey: PendingMap = {
      [`${B}:claude-code:A`]: [snap(B, 'claude-code', 'A', 't1', 1)],
    };
    expect(selectOthersPending(byKey, B, 'claude-code', 'A')).toEqual([]);
  });

  it('does not collide across agents that share a sessionId', () => {
    const byKey: PendingMap = {
      [`${B}:claude-code:X`]: [snap(B, 'claude-code', 'X', 'focused', 1)],
      [`${B}:codex:X`]: [snap(B, 'codex', 'X', 'other', 2)],
    };
    const others = selectOthersPending(byKey, B, 'claude-code', 'X');
    expect(others.map((p) => p.toolUseId)).toEqual(['other']);
  });

  it('treats the same agent:session on another bridge as "other"', () => {
    const byKey: PendingMap = {
      'b1:claude-code:A': [snap('b1', 'claude-code', 'A', 'focused', 1)],
      'b2:claude-code:A': [snap('b2', 'claude-code', 'A', 'other-machine', 2)],
    };
    const others = selectOthersPending(byKey, 'b1', 'claude-code', 'A');
    expect(others.map((p) => p.toolUseId)).toEqual(['other-machine']);
  });
});
