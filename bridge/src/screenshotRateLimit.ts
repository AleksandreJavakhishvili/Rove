/**
 * Per-session token bucket for the `take_screenshot` MCP tool.
 *
 * Defaults to {@link DEFAULT_CAPACITY} captures per
 * {@link DEFAULT_WINDOW_MS} milliseconds (configurable via env).
 * Bursts beyond the cap return a `retryAfterSeconds` so the agent's
 * text-content fallback can be specific ("rate_limited: retry in 12s").
 *
 * Buckets are lazily created and never garbage-collected — they're a
 * handful of bytes each, sessions don't churn that fast, and process
 * restart resets the state. Trade-off picked for simplicity over
 * memory.
 */

/** Default upper bound on captures per window. Six per minute is the
 *  manually-tuned floor that lets a "fix → verify → fix → verify" loop
 *  proceed without the user feeling throttled. */
const DEFAULT_CAPACITY = 6;
/** Lower / upper guards for the env override so a stray config can't
 *  set a zero cap (which would deadlock the tool) or an
 *  unreasonable one (which defeats the limiter). */
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 60;
/** Default sliding-window length. Sixty seconds chosen to read as
 *  "per minute" on the agent's retry-in-Ns text result. */
const DEFAULT_WINDOW_MS = 60_000;
/** Window-length guards — disallow sub-5s windows (too tight) and
 *  super-10min windows (the limit would feel permanent). */
const MIN_WINDOW_MS = 5_000;
const MAX_WINDOW_MS = 600_000;
const MS_PER_SECOND = 1_000;

const CAPACITY = clampInt(
  process.env.SCREENSHOT_RATE_CAP,
  DEFAULT_CAPACITY,
  MIN_CAPACITY,
  MAX_CAPACITY,
);
const WINDOW_MS = clampInt(
  process.env.SCREENSHOT_RATE_WINDOW_MS,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
);

interface Bucket {
  /** Timestamps (epoch ms) of recent successful consumes, oldest first. */
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export type RateLimitCheck =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/** Try to consume one token from the (agent, sessionId) bucket. */
export function checkAndConsume(agent: string, sessionId: string): RateLimitCheck {
  const key = `${agent}::${sessionId}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  // Drop entries older than the window.
  const cutoff = now - WINDOW_MS;
  while (bucket.timestamps.length > 0 && bucket.timestamps[0]! < cutoff) {
    bucket.timestamps.shift();
  }
  if (bucket.timestamps.length >= CAPACITY) {
    const oldest = bucket.timestamps[0]!;
    const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
    return {
      ok: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / MS_PER_SECOND),
    };
  }
  bucket.timestamps.push(now);
  return { ok: true };
}

/** Used by tests + debug surfaces. */
export function debugSnapshot(): { capacity: number; windowMs: number; bucketCount: number } {
  return { capacity: CAPACITY, windowMs: WINDOW_MS, bucketCount: buckets.size };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
