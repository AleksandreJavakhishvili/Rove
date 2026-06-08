import { randomUUID } from 'node:crypto';
import { SECRET_DEFAULT_PATH, SECRET_REQUEST_TIMEOUT_MS } from './agents/types.ts';
import { SecretWriteError, writeDotenvSecret } from './secretWriter.ts';

/**
 * Bridge ↔ client `set_secret` round-trip arbiter for the Rove Secrets
 * SDD (`docs/sdd/2026-06-07-rove-secrets/`). Mirrors `screenshotBroker.ts`
 * / `handoffBroker.ts`: a pending-Promise map, a timeout, a per-session
 * drain on disconnect, and a dispatch registry the WS handler populates.
 *
 * The secret VALUE never flows through here on the way out — only the
 * request (name + reason + path) is dispatched to the client. The value
 * arrives later via `provideSecret()` (called from the WS `secret_provide`
 * handler), is written straight to disk by `secretWriter`, and is dropped.
 * It never reaches the SDK / the model / the JSONL.
 */

export type SecretFailureStatus = 'denied' | 'timeout' | 'no_client' | 'cancelled' | 'error';

export type SecretOutcome =
  | {
      ok: true;
      requestId: string;
      name: string;
      where: string;
      gitignored: boolean;
      addedGitignore: boolean;
    }
  | {
      ok: false;
      requestId: string;
      name: string;
      status: SecretFailureStatus;
      detail?: string;
    };

interface RequestOptions {
  /** Session cwd — the root the destination path is confined to. */
  cwd: string;
  name: string;
  reason: string;
  /** Agent-suggested destination; defaults to `.env`. The user can override. */
  path?: string;
  timeoutMs?: number;
}

interface DispatchArgs {
  requestId: string;
  name: string;
  reason: string;
  path: string;
}

type Dispatch = (args: DispatchArgs) => void;

interface PendingEntry {
  sessionId: string;
  cwd: string;
  name: string;
  /** Resolved default destination, used when the client doesn't override. */
  defaultPath: string;
  resolve: (outcome: SecretOutcome) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

/**
 * Allocate a request, dispatch the prompt to the attached client, and
 * return a Promise that resolves when the user provides / denies (or the
 * timeout fires, or the session disconnects). Never rejects — every path
 * resolves so the MCP tool wrapper can render a value-free text result.
 */
export function requestSecret(
  sessionId: string,
  options: RequestOptions,
  dispatch: Dispatch,
): Promise<SecretOutcome> {
  const requestId = randomUUID();
  const defaultPath =
    options.path && options.path.trim() ? options.path.trim() : SECRET_DEFAULT_PATH;
  const timeoutMs = options.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS;
  return new Promise<SecretOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      resolve({ ok: false, requestId, name: options.name, status: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, {
      sessionId,
      cwd: options.cwd,
      name: options.name,
      defaultPath,
      resolve,
      timer,
    });
    try {
      dispatch({ requestId, name: options.name, reason: options.reason, path: defaultPath });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      console.warn('[secret-broker] dispatch threw', err);
      resolve({ ok: false, requestId, name: options.name, status: 'no_client' });
    }
  });
}

/**
 * The user pasted a value. Write it to disk (bridge-side, value never
 * re-emitted) and resolve the in-flight Promise with a value-free outcome.
 * `pathOverride` lets the user retarget the destination from the sheet.
 * Late / unknown `requestId`s are dropped silently.
 */
export function provideSecret(requestId: string, value: string, pathOverride?: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  const path = pathOverride && pathOverride.trim() ? pathOverride.trim() : entry.defaultPath;
  try {
    const res = writeDotenvSecret(entry.cwd, path, entry.name, value);
    entry.resolve({
      ok: true,
      requestId,
      name: entry.name,
      where: res.where,
      gitignored: res.gitignored,
      addedGitignore: res.addedGitignore,
    });
  } catch (err) {
    const detail =
      err instanceof SecretWriteError ? err.message : String((err as Error).message ?? err);
    entry.resolve({ ok: false, requestId, name: entry.name, status: 'error', detail });
  }
}

/** The user declined. Resolve the in-flight Promise as a non-fatal deny. */
export function denySecret(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve({ ok: false, requestId, name: entry.name, status: 'denied' });
}

/**
 * Drain every pending request for a session. Call on WS disconnect so the
 * agent's tool promise resolves instead of hanging until the timeout.
 */
export function cancelSecretsForSession(sessionId: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, requestId, name: entry.name, status: 'cancelled' });
  }
}

/** Used by tests / debug surfaces. */
export function pendingSecretCount(): number {
  return pending.size;
}

/** -------------------------------------------------------------------
 *  Dispatch registry — populated by the WS handler when a session WS is
 *  attached. The SDK tool calls `getSecretDispatch(sessionId)` to find
 *  the socket to push the `secret_request` frame onto; a session with no
 *  attached client gets a `no_client` outcome before a pending entry is
 *  ever created.
 *  ------------------------------------------------------------------ */

type Dispatcher = (args: DispatchArgs) => void;

const dispatchers = new Map<string, Dispatcher>();

export function registerSecretDispatch(sessionId: string, dispatcher: Dispatcher): void {
  dispatchers.set(sessionId, dispatcher);
}

export function unregisterSecretDispatch(sessionId: string, dispatcher: Dispatcher): void {
  // Only clear if the entry still points at this dispatcher — prevents a
  // stale unmount racing past a fresh reconnect.
  if (dispatchers.get(sessionId) === dispatcher) {
    dispatchers.delete(sessionId);
  }
}

export function getSecretDispatch(sessionId: string): Dispatcher | undefined {
  return dispatchers.get(sessionId);
}
