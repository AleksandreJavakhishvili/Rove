import { randomUUID } from 'node:crypto';
import {
  HANDOFF_DEFAULT_TIMEOUT_MS,
  HANDOFF_RESULT_STATUS,
  type HandoffResultStatus,
} from './agents/types.ts';

/**
 * Bridge ↔ mobile `prepare_preview` round-trip arbiter for the preview-
 * handoff SDD. Mirrors `screenshotBroker.ts` — pending Promise map +
 * timeout arming + per-session drain on disconnect — but resolves with
 * a {@link HandoffOutcome} instead of an image.
 *
 * See `docs/sdd/2026-05-25-preview-handoff/`.
 */

export type HandoffOutcome =
  | {
      ok: true;
      requestId: string;
      status: HandoffResultStatus;
      finalUrl?: string;
      note?: string;
    }
  | { ok: false; requestId: string; status: HandoffResultStatus };

interface RequestOptions {
  instructions: string;
  suggestedPath?: string;
  /** Hard ceiling on the bridge↔phone↔bridge round-trip. */
  timeoutMs?: number;
}

interface DispatchArgs {
  requestId: string;
  instructions: string;
  suggestedPath?: string;
  timeoutSeconds?: number;
}

type Dispatch = (args: DispatchArgs) => void;

interface PendingEntry {
  sessionId: string;
  resolve: (outcome: HandoffOutcome) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

export function requestHandoff(
  sessionId: string,
  options: RequestOptions,
  dispatch: Dispatch,
): Promise<HandoffOutcome> {
  const requestId = randomUUID();
  const timeoutMs = options.timeoutMs ?? HANDOFF_DEFAULT_TIMEOUT_MS;
  return new Promise<HandoffOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      resolve({ ok: false, requestId, status: HANDOFF_RESULT_STATUS.timeout });
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { sessionId, resolve, timer });
    try {
      dispatch({
        requestId,
        instructions: options.instructions,
        ...(options.suggestedPath !== undefined ? { suggestedPath: options.suggestedPath } : {}),
        ...(options.timeoutMs !== undefined
          ? { timeoutSeconds: Math.round(options.timeoutMs / 1000) }
          : {}),
      });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      console.warn('[handoff-broker] dispatch threw', err);
      resolve({ ok: false, requestId, status: HANDOFF_RESULT_STATUS.no_client });
    }
  });
}

/**
 * Route a `prepare_preview_result` frame from the phone to the in-
 * flight Promise. Late / unknown `requestId`s are dropped silently.
 */
export function resolveHandoff(
  requestId: string,
  payload:
    | {
        ok: true;
        status: HandoffResultStatus;
        finalUrl?: string;
        note?: string;
      }
    | { ok: false; status: HandoffResultStatus },
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (payload.ok) {
    entry.resolve({
      ok: true,
      requestId,
      status: payload.status,
      ...(payload.finalUrl !== undefined ? { finalUrl: payload.finalUrl } : {}),
      ...(payload.note !== undefined ? { note: payload.note } : {}),
    });
  } else {
    entry.resolve({ ok: false, requestId, status: payload.status });
  }
}

/**
 * Drain every pending handoff for a session with the given status.
 * Call on WS disconnect so the agent's tool promise doesn't hang.
 */
export function cancelHandoffsForSession(
  sessionId: string,
  status: HandoffResultStatus,
): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, requestId, status });
  }
}

/** Used by tests / debug surfaces. */
export function pendingHandoffCount(): number {
  return pending.size;
}
