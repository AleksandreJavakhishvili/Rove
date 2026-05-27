import {
  reduce,
  type PreviewDirectionEffect,
  type PreviewDirectionState,
  type PriorState,
} from '../previewDirectionMachine';

const snapshot: PriorState = { pagerIndex: 0, workspaceMode: 'files' };

function makeRequest(requestId = 'req-1', path?: string) {
  return {
    kind: 'request' as const,
    direction: 'agent' as const,
    requestId,
    snapshot,
    ...(path !== undefined ? { path } : {}),
  };
}

function effectKinds(effects: PreviewDirectionEffect[]): string[] {
  return effects.map((e) => e.kind);
}

describe('previewDirectionMachine.reduce', () => {
  describe('happy path', () => {
    it('idle + request → requesting (no effects until granted)', () => {
      const { state, effects } = reduce({ kind: 'idle' }, makeRequest());
      expect(state.kind).toBe('requesting');
      expect(effects).toEqual([]);
    });

    it('requesting + permission_granted → engaging + engage effect', () => {
      const after = reduce({ kind: 'idle' }, makeRequest());
      const { state, effects } = reduce(after.state, { kind: 'permission_granted' });
      expect(state.kind).toBe('engaging');
      expect(effectKinds(effects)).toEqual(['engage']);
    });

    it('engaging + engaged → active + capture effect', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest()).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      const { state, effects } = reduce(s, { kind: 'engaged' });
      expect(state.kind).toBe('active');
      expect(effectKinds(effects)).toEqual(['capture']);
    });

    it('active + capture_complete → active + arm_debounce', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest()).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      const { state, effects } = reduce(s, { kind: 'capture_complete' });
      expect(state.kind).toBe('active');
      expect(effectKinds(effects)).toEqual(['arm_debounce']);
    });

    it('active + debounce_expired → exiting + restore', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest()).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      s = reduce(s, { kind: 'capture_complete' }).state;
      const { state, effects } = reduce(s, { kind: 'debounce_expired' });
      expect(state.kind).toBe('exiting');
      expect(effectKinds(effects)).toEqual(['restore']);
    });

    it('exiting + exit_complete → idle', () => {
      const exiting: PreviewDirectionState = {
        kind: 'exiting',
        direction: 'agent',
        snapshot,
      };
      const { state } = reduce(exiting, { kind: 'exit_complete' });
      expect(state.kind).toBe('idle');
    });
  });

  describe('permission denial', () => {
    it('requesting + permission_denied → idle + reply_denied', () => {
      const after = reduce({ kind: 'idle' }, makeRequest('req-x'));
      const { state, effects } = reduce(after.state, { kind: 'permission_denied' });
      expect(state.kind).toBe('idle');
      expect(effects).toEqual([{ kind: 'reply_denied', requestId: 'req-x' }]);
    });
  });

  describe('cancel taps', () => {
    it('engaging + cancel_tapped → exiting + reply_cancelled + restore', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest('req-c')).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      const { state, effects } = reduce(s, { kind: 'cancel_tapped' });
      expect(state.kind).toBe('exiting');
      expect(effectKinds(effects)).toEqual([
        'reply_cancelled',
        'clear_debounce',
        'restore',
      ]);
    });

    it('active + cancel_tapped → exiting + reply_cancelled + restore', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest('req-d')).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      const { state, effects } = reduce(s, { kind: 'cancel_tapped' });
      expect(state.kind).toBe('exiting');
      expect(effectKinds(effects)).toEqual([
        'reply_cancelled',
        'clear_debounce',
        'restore',
      ]);
    });
  });

  describe('debounce — chained requests', () => {
    it('active + new request → active + cancel + clear_debounce + capture', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest('req-1')).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      // capture in flight: we received capture_complete + armed debounce
      s = reduce(s, { kind: 'capture_complete' }).state;
      const { state, effects } = reduce(s, makeRequest('req-2', '/about'));
      expect(state.kind).toBe('active');
      if (state.kind === 'active') {
        expect(state.requestId).toBe('req-2');
        expect(state.path).toBe('/about');
        expect(state.snapshot).toEqual(snapshot);
      }
      // No cancel needed (capture already completed) but we still issue
      // clear_debounce + capture for the new request.
      expect(effectKinds(effects)).toEqual([
        'cancel_in_flight',
        'clear_debounce',
        'capture',
      ]);
    });
  });

  describe('ws_closed teardown', () => {
    it('ws_closed during active → idle + timer cleanups (no restore)', () => {
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, makeRequest()).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      const { state, effects } = reduce(s, { kind: 'ws_closed' });
      expect(state.kind).toBe('idle');
      // Both debounce (agent) and handoff-timeout (user) get cleared
      // — the interpreter no-ops the irrelevant one cheaply.
      expect(effectKinds(effects)).toEqual([
        'clear_debounce',
        'clear_handoff_timeout',
      ]);
    });

    it('ws_closed during idle is a no-op', () => {
      const { state, effects } = reduce({ kind: 'idle' }, { kind: 'ws_closed' });
      expect(state.kind).toBe('idle');
      expect(effects).toEqual([]);
    });
  });

  describe('handoff direction', () => {
    const handoff = {
      instructions: 'Please log in to /admin',
      suggestedPath: '/admin',
      timeoutSeconds: 60,
    };

    it('idle + handoff_request → modal + show_handoff_modal + arm_handoff_timeout', () => {
      const { state, effects } = reduce(
        { kind: 'idle' },
        {
          kind: 'handoff_request',
          requestId: 'h-1',
          handoff,
          snapshot,
        },
      );
      expect(state.kind).toBe('modal');
      expect(effectKinds(effects)).toEqual([
        'show_handoff_modal',
        'arm_handoff_timeout',
      ]);
    });

    it('modal + open_preview_tapped → engaging + morph_to_pill + engage', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-2', handoff, snapshot },
      ).state;
      const { state, effects } = reduce(s, { kind: 'open_preview_tapped' });
      expect(state.kind).toBe('engaging');
      if (state.kind === 'engaging') {
        expect(state.direction).toBe('user');
        expect(state.policy).toBe('explicit');
        expect(state.path).toBe('/admin');
      }
      expect(effectKinds(effects)).toEqual(['morph_to_pill', 'engage']);
    });

    it('engaging (user) + done_tapped → exiting + reply_handoff(ready)', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-3', handoff, snapshot },
      ).state;
      s = reduce(s, { kind: 'open_preview_tapped' }).state;
      const { state, effects } = reduce(s, { kind: 'done_tapped', finalUrl: '/admin' });
      expect(state.kind).toBe('exiting');
      const reply = effects.find((e) => e.kind === 'reply_handoff');
      expect(reply).toMatchObject({ status: 'ready', finalUrl: '/admin' });
    });

    it('modal + skip_tapped → idle + reply_handoff(skipped) + clear_handoff_timeout', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-4', handoff, snapshot },
      ).state;
      const { state, effects } = reduce(s, { kind: 'skip_tapped', note: 'no time' });
      expect(state.kind).toBe('idle');
      expect(effectKinds(effects)).toEqual([
        'reply_handoff',
        'clear_handoff_timeout',
      ]);
      const reply = effects.find((e) => e.kind === 'reply_handoff');
      expect(reply).toMatchObject({ status: 'skipped', note: 'no time' });
    });

    it('modal + cancel_tapped → idle + reply_handoff(cancelled)', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-5', handoff, snapshot },
      ).state;
      const { state, effects } = reduce(s, { kind: 'cancel_tapped' });
      expect(state.kind).toBe('idle');
      const reply = effects.find((e) => e.kind === 'reply_handoff');
      expect(reply).toMatchObject({ status: 'cancelled' });
    });

    it('engaging (user) + cancel_tapped → exiting + reply_handoff(cancelled)', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-6', handoff, snapshot },
      ).state;
      s = reduce(s, { kind: 'open_preview_tapped' }).state;
      const { state, effects } = reduce(s, { kind: 'cancel_tapped' });
      expect(state.kind).toBe('exiting');
      const reply = effects.find((e) => e.kind === 'reply_handoff');
      expect(reply).toMatchObject({ status: 'cancelled' });
    });

    it('modal + timeout_fired → idle + clear_handoff_timeout', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-7', handoff, snapshot },
      ).state;
      const { state, effects } = reduce(s, { kind: 'timeout_fired' });
      expect(state.kind).toBe('idle');
      expect(effectKinds(effects)).toEqual(['clear_handoff_timeout']);
    });

    it('done_tapped exit carries a grace window so a follow-up screenshot can re-engage', () => {
      let s: PreviewDirectionState = reduce(
        { kind: 'idle' },
        { kind: 'handoff_request', requestId: 'h-8', handoff, snapshot },
      ).state;
      s = reduce(s, { kind: 'open_preview_tapped' }).state;
      const { effects } = reduce(s, { kind: 'done_tapped' });
      const restoreEffect = effects.find((e) => e.kind === 'restore');
      expect(restoreEffect).toBeDefined();
      if (restoreEffect && restoreEffect.kind === 'restore') {
        expect(restoreEffect.gracePeriodMs).toBeGreaterThan(0);
      }
    });
  });

  describe('snapshot threading', () => {
    it('snapshot from the original request rides through to restore', () => {
      const custom: PriorState = { pagerIndex: 0, workspaceMode: 'preview' };
      const requestWith: ReturnType<typeof makeRequest> = {
        kind: 'request',
        direction: 'agent',
        requestId: 'snap-1',
        snapshot: custom,
      };
      let s: PreviewDirectionState = reduce({ kind: 'idle' }, requestWith).state;
      s = reduce(s, { kind: 'permission_granted' }).state;
      s = reduce(s, { kind: 'engaged' }).state;
      s = reduce(s, { kind: 'capture_complete' }).state;
      const { effects } = reduce(s, { kind: 'debounce_expired' });
      expect(effects).toEqual([{ kind: 'restore', snapshot: custom }]);
    });
  });
});
