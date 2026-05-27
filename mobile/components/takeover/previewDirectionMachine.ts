/**
 * Pure reducer for the preview-takeover state machine. Designed so the
 * handoff SDD (`docs/sdd/2026-05-25-preview-handoff/`) can extend
 * `Direction` and `Policy` without restructuring transitions.
 *
 * The reducer never reaches outside its inputs — every side effect is
 * returned as a descriptor for the React hook (`useTakeover`) to
 * interpret. This keeps the reducer unit-testable without a render
 * context and prevents drift between the state machine and the
 * imperative ref calls.
 */

/** Who's driving the WebView right now. `'agent'` for the
 *  take_screenshot path; `'user'` for the prepare_preview handoff
 *  where the user is doing the setup work. */
export type Direction = 'agent' | 'user';

/** How the mode unwinds. `'debounce'` = exit after a quiet window
 *  (agent-direction); `'explicit'` = exit only on an explicit
 *  Done/Cancel/Skip tap (user-direction). */
export type Policy = 'debounce' | 'explicit';

/** Snapshot captured on entry so the controller can restore the user's
 *  prior chrome on exit. */
export interface PriorState {
  pagerIndex: number;
  workspaceMode: 'files' | 'preview';
}

/** Extra context the handoff carries. Embedded on `modal` / `engaging` /
 *  `active` states whenever `direction === 'user'`. */
export interface HandoffContext {
  instructions: string;
  suggestedPath?: string;
  timeoutSeconds?: number;
}

export type PreviewDirectionState =
  | { kind: 'idle' }
  | {
      kind: 'requesting';
      direction: Direction;
      requestId: string;
      path?: string;
      waitMs?: number;
      snapshot: PriorState;
    }
  // `modal` is the user-direction analogue of `requesting`: the
  // HandoffSheet is up, waiting for the user to tap Open Preview /
  // Skip / Cancel. No chrome lock yet — the user can still see what's
  // underneath.
  | {
      kind: 'modal';
      direction: 'user';
      policy: 'explicit';
      requestId: string;
      snapshot: PriorState;
      handoff: HandoffContext;
    }
  | {
      kind: 'engaging';
      direction: Direction;
      policy: Policy;
      requestId: string;
      path?: string;
      waitMs?: number;
      snapshot: PriorState;
      handoff?: HandoffContext;
    }
  | {
      kind: 'active';
      direction: Direction;
      policy: Policy;
      requestId: string;
      path?: string;
      waitMs?: number;
      snapshot: PriorState;
      handoff?: HandoffContext;
    }
  | {
      kind: 'exiting';
      direction: Direction;
      snapshot: PriorState;
      /** Set when the controller should hold the exit briefly so a
       *  follow-up `take_screenshot` can re-enter without flicker.
       *  Preview-handoff Phase 2 grace window. */
      gracePeriodMs?: number;
    };

export type PreviewDirectionEvent =
  | {
      kind: 'request';
      direction: Direction;
      requestId: string;
      path?: string;
      waitMs?: number;
      snapshot: PriorState;
    }
  | { kind: 'permission_granted' }
  | { kind: 'permission_denied' }
  | { kind: 'engaged' }
  | { kind: 'capture_complete' }
  | { kind: 'debounce_expired' }
  | { kind: 'cancel_tapped' }
  | { kind: 'ws_closed' }
  | { kind: 'exit_complete' }
  // Preview-handoff Phase 1 events.
  | {
      kind: 'handoff_request';
      requestId: string;
      handoff: HandoffContext;
      snapshot: PriorState;
    }
  /** User tapped "Open Preview" on the HandoffSheet. */
  | { kind: 'open_preview_tapped' }
  /** User tapped "Done" on the HandoffPill — reply `ready`. */
  | { kind: 'done_tapped'; finalUrl?: string }
  /** User tapped "Skip" with an optional note — reply `skipped`. */
  | { kind: 'skip_tapped'; note?: string }
  /** Broker-side timeout was already armed when the agent called; the
   *  controller mirrors it so the UI tears down on the same boundary
   *  as the bridge. */
  | { kind: 'timeout_fired' };

export type PreviewDirectionEffect =
  | { kind: 'engage'; snapshot: PriorState; suggestedPath?: string }
  | { kind: 'capture'; requestId: string; path?: string; waitMs?: number }
  | { kind: 'cancel_in_flight'; requestId: string }
  | { kind: 'arm_debounce' }
  | { kind: 'clear_debounce' }
  | { kind: 'restore'; snapshot: PriorState; gracePeriodMs?: number }
  | { kind: 'reply_denied'; requestId: string }
  | { kind: 'reply_cancelled'; requestId: string }
  // Preview-handoff Phase 1 effects.
  | {
      kind: 'show_handoff_modal';
      requestId: string;
      handoff: HandoffContext;
    }
  /** Sheet → pill cross-fade once the user tapped Open Preview. */
  | { kind: 'morph_to_pill'; handoff: HandoffContext }
  /** Send the handoff WS reply with the user's decision. */
  | {
      kind: 'reply_handoff';
      requestId: string;
      status: 'ready' | 'skipped' | 'cancelled';
      finalUrl?: string;
      note?: string;
    }
  /** Mirror the bridge-side timeout so the UI tears down on the same
   *  boundary. The interpreter arms a setTimeout that dispatches
   *  `timeout_fired` if the user doesn't reply. */
  | { kind: 'arm_handoff_timeout'; timeoutSeconds?: number }
  /** Cancel the handoff-timeout timer. */
  | { kind: 'clear_handoff_timeout' };

export interface ReduceResult {
  state: PreviewDirectionState;
  effects: PreviewDirectionEffect[];
}

const idle: PreviewDirectionState = { kind: 'idle' };

/**
 * Apply one event to the current state. Pure — same input always
 * returns the same output (modulo the input being structurally
 * identical). Effects are returned in the order they should be applied;
 * the hook interpreter walks the array.
 */
export function reduce(
  state: PreviewDirectionState,
  event: PreviewDirectionEvent,
): ReduceResult {
  switch (event.kind) {
    case 'request': {
      // From idle: enter the request flow.
      if (state.kind === 'idle') {
        return {
          state: {
            kind: 'requesting',
            direction: event.direction,
            requestId: event.requestId,
            ...(event.path !== undefined ? { path: event.path } : {}),
            ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
            snapshot: event.snapshot,
          },
          effects: [],
        };
      }
      // Mid-takeover (engaging / active / exiting) — a fresh request
      // arrives. Cancel any in-flight capture (so the agent doesn't get
      // two replies for one requestId from before), reset the debounce
      // window, and re-enter `active` with the new request. The
      // existing snapshot stays — we never re-snapshot mid-burst because
      // the prior state we want to restore on exit is the pre-burst one.
      if (state.kind === 'active' || state.kind === 'engaging' || state.kind === 'exiting') {
        const effects: PreviewDirectionEffect[] = [];
        // If a capture is in flight, mark it cancelled so a late reply
        // from the previous request doesn't double-resolve.
        if (state.kind === 'active' || state.kind === 'engaging') {
          effects.push({ kind: 'cancel_in_flight', requestId: state.requestId });
        }
        effects.push({ kind: 'clear_debounce' });
        effects.push({
          kind: 'capture',
          requestId: event.requestId,
          ...(event.path !== undefined ? { path: event.path } : {}),
          ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
        });
        return {
          state: {
            kind: 'active',
            direction: event.direction,
            policy: 'debounce',
            requestId: event.requestId,
            ...(event.path !== undefined ? { path: event.path } : {}),
            ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
            snapshot: state.snapshot,
          },
          effects,
        };
      }
      // `requesting`: queue would arrive here in a multi-request design.
      // We keep it simple: drop the new request and stay in the current
      // request flow. The new request will be re-issued by the agent
      // (the SDK's tool loop will see no reply and timeout-retry).
      return { state, effects: [] };
    }

    case 'permission_granted': {
      if (state.kind !== 'requesting') return { state, effects: [] };
      return {
        state: {
          kind: 'engaging',
          direction: state.direction,
          policy: 'debounce',
          requestId: state.requestId,
          ...(state.path !== undefined ? { path: state.path } : {}),
          ...(state.waitMs !== undefined ? { waitMs: state.waitMs } : {}),
          snapshot: state.snapshot,
        },
        effects: [{ kind: 'engage', snapshot: state.snapshot }],
      };
    }

    case 'permission_denied': {
      if (state.kind !== 'requesting') return { state, effects: [] };
      // Permission denial → reply to the agent; no chrome to restore
      // because we never engaged.
      return {
        state: idle,
        effects: [{ kind: 'reply_denied', requestId: state.requestId }],
      };
    }

    case 'engaged': {
      if (state.kind !== 'engaging') return { state, effects: [] };
      return {
        state: {
          kind: 'active',
          direction: state.direction,
          policy: state.policy,
          requestId: state.requestId,
          ...(state.path !== undefined ? { path: state.path } : {}),
          ...(state.waitMs !== undefined ? { waitMs: state.waitMs } : {}),
          snapshot: state.snapshot,
        },
        effects: [
          {
            kind: 'capture',
            requestId: state.requestId,
            ...(state.path !== undefined ? { path: state.path } : {}),
            ...(state.waitMs !== undefined ? { waitMs: state.waitMs } : {}),
          },
        ],
      };
    }

    case 'capture_complete': {
      if (state.kind !== 'active') return { state, effects: [] };
      // Stay in `active`; the debounce window decides whether to exit.
      return { state, effects: [{ kind: 'arm_debounce' }] };
    }

    case 'debounce_expired': {
      if (state.kind !== 'active') return { state, effects: [] };
      return {
        state: {
          kind: 'exiting',
          direction: state.direction,
          snapshot: state.snapshot,
        },
        effects: [{ kind: 'restore', snapshot: state.snapshot }],
      };
    }

    case 'cancel_tapped': {
      // Cancellable from modal / engaging / active. The reply
      // descriptor is direction-specific: agent → reply_cancelled
      // (screenshot_result), user → reply_handoff(cancelled).
      if (state.kind === 'modal') {
        return {
          state: idle,
          effects: [
            {
              kind: 'reply_handoff',
              requestId: state.requestId,
              status: 'cancelled',
            },
            { kind: 'clear_handoff_timeout' },
          ],
        };
      }
      if (state.kind === 'engaging' || state.kind === 'active') {
        const replyEffect: PreviewDirectionEffect =
          state.direction === 'user'
            ? {
                kind: 'reply_handoff',
                requestId: state.requestId,
                status: 'cancelled',
              }
            : { kind: 'reply_cancelled', requestId: state.requestId };
        const teardownEffects: PreviewDirectionEffect[] =
          state.direction === 'user'
            ? [{ kind: 'clear_handoff_timeout' }]
            : [{ kind: 'clear_debounce' }];
        return {
          state: {
            kind: 'exiting',
            direction: state.direction,
            snapshot: state.snapshot,
          },
          effects: [replyEffect, ...teardownEffects, { kind: 'restore', snapshot: state.snapshot }],
        };
      }
      return { state, effects: [] };
    }

    case 'ws_closed': {
      // Screen is being torn down or session disconnecting. Don't
      // restore — the chat screen is about to unmount and the broker
      // will drain any pending bridge-side requests with `cancelled`.
      if (state.kind === 'idle') return { state, effects: [] };
      return {
        state: idle,
        effects: [{ kind: 'clear_debounce' }, { kind: 'clear_handoff_timeout' }],
      };
    }

    case 'exit_complete': {
      if (state.kind !== 'exiting') return { state, effects: [] };
      return { state: idle, effects: [] };
    }

    case 'handoff_request': {
      // From idle: open the HandoffSheet + arm the timeout. We don't
      // engage chrome yet — the user might tap Skip / Cancel before
      // any pager swap is appropriate.
      if (state.kind === 'idle') {
        return {
          state: {
            kind: 'modal',
            direction: 'user',
            policy: 'explicit',
            requestId: event.requestId,
            snapshot: event.snapshot,
            handoff: event.handoff,
          },
          effects: [
            {
              kind: 'show_handoff_modal',
              requestId: event.requestId,
              handoff: event.handoff,
            },
            {
              kind: 'arm_handoff_timeout',
              ...(event.handoff.timeoutSeconds !== undefined
                ? { timeoutSeconds: event.handoff.timeoutSeconds }
                : {}),
            },
          ],
        };
      }
      // Mid-takeover (agent or user): a new handoff arrives. The plan
      // says to keep this simple — the new request gets dropped and
      // the agent's SDK loop will retry. This keeps the UX coherent
      // (no surprise sheet pop-ups during agent capture) and matches
      // the "agent path queues are not supported" stance.
      return { state, effects: [] };
    }

    case 'open_preview_tapped': {
      if (state.kind !== 'modal') return { state, effects: [] };
      const { handoff } = state;
      return {
        state: {
          kind: 'engaging',
          direction: 'user',
          policy: 'explicit',
          requestId: state.requestId,
          ...(handoff.suggestedPath !== undefined ? { path: handoff.suggestedPath } : {}),
          snapshot: state.snapshot,
          handoff,
        },
        effects: [
          { kind: 'morph_to_pill', handoff },
          {
            kind: 'engage',
            snapshot: state.snapshot,
            ...(handoff.suggestedPath !== undefined
              ? { suggestedPath: handoff.suggestedPath }
              : {}),
          },
        ],
      };
    }

    case 'done_tapped': {
      // Done is the user-direction analogue of capture_complete. We
      // reply `ready` to the agent, then exit. The interpreter holds
      // for `HANDOFF_TO_CAPTURE_GRACE_MS` so a follow-up
      // `take_screenshot` can re-enter without a chrome flicker.
      if (state.kind !== 'engaging' && state.kind !== 'active' && state.kind !== 'modal') {
        return { state, effects: [] };
      }
      const requestId = state.requestId;
      const replyEffect: PreviewDirectionEffect = {
        kind: 'reply_handoff',
        requestId,
        status: 'ready',
        ...(event.finalUrl !== undefined ? { finalUrl: event.finalUrl } : {}),
      };
      // From modal — no chrome to restore (we never engaged).
      if (state.kind === 'modal') {
        return {
          state: idle,
          effects: [replyEffect, { kind: 'clear_handoff_timeout' }],
        };
      }
      return {
        state: {
          kind: 'exiting',
          direction: state.direction,
          snapshot: state.snapshot,
          gracePeriodMs: HANDOFF_GRACE_MS,
        },
        effects: [
          replyEffect,
          { kind: 'clear_handoff_timeout' },
          { kind: 'restore', snapshot: state.snapshot, gracePeriodMs: HANDOFF_GRACE_MS },
        ],
      };
    }

    case 'skip_tapped': {
      // Reply skipped + exit. Same chrome-restore policy as cancel
      // (no grace window because the agent specifically chose to skip,
      // not to capture next).
      if (state.kind !== 'modal' && state.kind !== 'engaging' && state.kind !== 'active') {
        return { state, effects: [] };
      }
      const requestId = state.requestId;
      const replyEffect: PreviewDirectionEffect = {
        kind: 'reply_handoff',
        requestId,
        status: 'skipped',
        ...(event.note !== undefined ? { note: event.note } : {}),
      };
      if (state.kind === 'modal') {
        return {
          state: idle,
          effects: [replyEffect, { kind: 'clear_handoff_timeout' }],
        };
      }
      return {
        state: {
          kind: 'exiting',
          direction: state.direction,
          snapshot: state.snapshot,
        },
        effects: [
          replyEffect,
          { kind: 'clear_handoff_timeout' },
          { kind: 'restore', snapshot: state.snapshot },
        ],
      };
    }

    case 'timeout_fired': {
      // Phone-side mirror of the bridge timeout — we don't reply
      // (the bridge has already resolved the tool promise on its
      // own timer) but we DO tear down the UI cleanly.
      if (state.kind !== 'modal' && state.kind !== 'engaging' && state.kind !== 'active') {
        return { state, effects: [] };
      }
      if (state.kind === 'modal') {
        return { state: idle, effects: [{ kind: 'clear_handoff_timeout' }] };
      }
      return {
        state: {
          kind: 'exiting',
          direction: state.direction,
          snapshot: state.snapshot,
        },
        effects: [
          { kind: 'clear_handoff_timeout' },
          { kind: 'restore', snapshot: state.snapshot },
        ],
      };
    }
  }
}

/** Mobile mirror of `HANDOFF_TO_CAPTURE_GRACE_MS`. Kept inline rather
 *  than imported from `lib/types.ts` to avoid pulling the wire-types
 *  module into the pure reducer file (and its tests). */
const HANDOFF_GRACE_MS = 500;
