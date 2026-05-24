import { basename } from 'node:path';
import { config } from './config.ts';
import { getDriver } from './agents/registry.ts';
import { devices } from './devices.ts';
import type { AgentEvent, AgentKind, AgentSession } from './agents/types.ts';

function key(agent: AgentKind, sessionId: string): string {
  return `${agent}::${sessionId}`;
}

class SessionRuntime {
  private map = new Map<string, AgentSession>();
  private reaper: NodeJS.Timeout | null = null;

  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reap(), config.reaperIntervalMs);
  }

  stopReaper(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  livePids(): Map<string, number> {
    const out = new Map<string, number>();
    for (const session of this.map.values()) {
      if (session.alive && session.pid !== undefined) {
        out.set(key(session.agent, session.sessionId), session.pid);
      }
    }
    return out;
  }

  get(agent: AgentKind, sessionId: string): AgentSession | undefined {
    return this.map.get(key(agent, sessionId));
  }

  /**
   * Checks for a live desktop process holding the session file. Returns the
   * list of foreign PIDs if one is found, or null if the session is free.
   *
   * Finishes with a `process.kill(pid, 0)` liveness probe so a stale entry
   * in the lsof cache (or a pid that died between the ps snapshot and this
   * call) can't surface a phantom desktop conflict. Without this, a fresh
   * takeover would routinely fire `session_busy` again on the very next
   * user message because the cache hadn't refreshed yet.
   */
  async checkDesktopConflict(agent: AgentKind, sessionId: string): Promise<number[] | null> {
    const driver = getDriver(agent);
    if (!driver) return null;
    const ourPid = this.get(agent, sessionId)?.pid;
    const allPids = await driver.getDesktopPids(sessionId);
    const foreign = allPids.filter((p) => p !== ourPid && p !== process.pid);
    if (foreign.length === 0) return null;
    const alive = foreign.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    return alive.length ? alive : null;
  }

  async getOrCreate(agent: AgentKind, sessionId: string): Promise<AgentSession> {
    const k = key(agent, sessionId);
    const existing = this.map.get(k);
    if (existing) return existing;

    const driver = getDriver(agent);
    if (!driver) throw new Error(`unknown agent: ${agent}`);

    const located = await driver.findSession(sessionId);
    if (!located) throw new Error(`session not found: ${agent}/${sessionId}`);

    const session = driver.createSession(sessionId, located.cwd);
    session.on('exit', () => {
      if (this.map.get(k) === session) this.map.delete(k);
    });
    // Hook 'result' events for off-screen push notifications. Fires only when
    // nobody is actively watching the session via WebSocket.
    session.on('event', (e: AgentEvent) => {
      if (e.type !== 'result') return;
      if (session.subscribers > 0) return;
      const project = basename(located.cwd) || 'session';
      const ok = e.subtype === 'success';
      void devices.pushToAll({
        title: ok ? `${project} finished` : `${project} stopped`,
        body: ok
          ? `Your agent turn completed. Tap to review.`
          : `Turn ended (${e.subtype}). Tap to open.`,
        data: { agent, sessionId, subtype: e.subtype },
      });
    });
    this.map.set(k, session);
    return session;
  }

  private reap(): void {
    const now = Date.now();
    for (const [k, session] of this.map) {
      if (session.subscribers > 0) continue;
      if (now - session.lastActivity > config.idleTimeoutMs) {
        if (session.pid === undefined) {
          // Subprocess was never spawned — nothing to kill. Just evict the
          // registry entry so we stop logging about it every minute.
          this.map.delete(k);
          continue;
        }
        console.log(`[reaper] killing idle session ${k} (pid=${session.pid})`);
        session.shutdown();
      }
    }
  }

  shutdownAll(): void {
    for (const session of this.map.values()) session.shutdown();
    this.map.clear();
  }
}

export const runtime = new SessionRuntime();
