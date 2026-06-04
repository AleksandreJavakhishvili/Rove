import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const configDir = join(homedir(), '.config', 'rove');
const bridgeIdFile = join(configDir, 'bridge-id');

/**
 * Stable per-bridge identifier, persisted across restarts. Reported on
 * `/health` so the mobile aggregator can key sessions / approvals by bridge.
 * The bridge stays agnostic of the *name* the user gives it — that lives on
 * the phone. Precedence: `BRIDGE_ID` env > persisted file > freshly generated
 * (then persisted). Never throws: if the disk isn't writable we fall back to
 * an in-memory id for this run.
 */
function resolveBridgeId(): string {
  const fromEnv = process.env.BRIDGE_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const existing = readFileSync(bridgeIdFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // file not created yet — fall through to generate
  }
  const generated = randomUUID();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(bridgeIdFile, generated, 'utf8');
  } catch {
    // disk not writable — use the in-memory id for this run
  }
  return generated;
}

export const config = {
  /** Explicit bind override. When undefined, the bridge auto-detects (see runtimeState.bindHost). */
  host: process.env.HOST,
  port: Number(process.env.PORT ?? 8443),
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  projectsDir: process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects'),
  /** Claude v2.x live-session registry dir (~/.claude/sessions/<pid>.json). */
  sessionsDir: process.env.CLAUDE_SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions'),
  /** Harness task store (~/.claude/tasks/<session-id>/<n>.json) — the
   *  authoritative source for the TaskCreate/TaskUpdate checklist. */
  tasksDir: process.env.CLAUDE_TASKS_DIR ?? join(homedir(), '.claude', 'tasks'),
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS ?? 5 * 60 * 1000),
  reaperIntervalMs: Number(process.env.REAPER_INTERVAL_MS ?? 60 * 1000),
  allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  bearerToken: process.env.BEARER_TOKEN,
  historyMaxEntries: Number(process.env.HISTORY_MAX_ENTRIES ?? 50),
  /** Stable id for this bridge; see resolveBridgeId. */
  bridgeId: resolveBridgeId(),
} as const;

/**
 * Resolved at startup by server.ts. Use these instead of `config.host` when you
 * need the *actual* bind address or the safe form of "is this truly a local
 * loopback connection (no proxy in front)?".
 */
export const runtimeState = {
  bindHost: '127.0.0.1' as string,
  /** 'http' when serving plain, 'https' when we acquired a Let's Encrypt cert. */
  urlScheme: 'http' as 'http' | 'https',
  /** True only when bound to loopback AND no Tailscale serve / proxy is in front. */
  loopbackDevAllowed: false,
  /** Set if Tailscale is currently running on this machine. */
  tailscaleHostname: null as string | null,
  /** Set if `tailscale serve` is currently fronting us. */
  tailscaleServing: false,
  /**
   * Effective bearer token — either the explicit `BEARER_TOKEN` env var or an
   * auto-generated one (printed inside the connection QR so the phone can
   * scan-and-go). When `tailscale serve` fronts us, this stays undefined and
   * auth relies on Tailscale identity headers instead.
   */
  bearerToken: undefined as string | undefined,
};
