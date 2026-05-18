import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentKind } from './agents/types.ts';

export interface SessionMeta {
  /** User-given label that overrides the auto-derived project name. */
  label?: string;
}

const STORE_PATH = join(homedir(), '.rove', 'session-meta.json');

function k(agent: AgentKind, id: string): string {
  return `${agent}::${id}`;
}

class SessionMetaStore {
  private map: Map<string, SessionMeta> = new Map();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, SessionMeta>;
      for (const [key, meta] of Object.entries(parsed)) {
        if (meta && typeof meta === 'object') this.map.set(key, meta);
      }
    } catch {
      // first run, fine
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(STORE_PATH), { recursive: true });
      const obj: Record<string, SessionMeta> = {};
      for (const [key, meta] of this.map) obj[key] = meta;
      await writeFile(STORE_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[session-meta] failed to persist:', (err as Error).message);
    }
  }

  async get(agent: AgentKind, id: string): Promise<SessionMeta | undefined> {
    await this.load();
    return this.map.get(k(agent, id));
  }

  async getMany(keys: Array<{ agent: AgentKind; id: string }>): Promise<Map<string, SessionMeta>> {
    await this.load();
    const out = new Map<string, SessionMeta>();
    for (const { agent, id } of keys) {
      const m = this.map.get(k(agent, id));
      if (m) out.set(k(agent, id), m);
    }
    return out;
  }

  async setLabel(agent: AgentKind, id: string, label: string | null): Promise<void> {
    await this.load();
    const key = k(agent, id);
    const existing = this.map.get(key) ?? {};
    if (label === null || label.trim() === '') {
      delete existing.label;
    } else {
      existing.label = label.trim().slice(0, 120);
    }
    if (Object.keys(existing).length === 0) this.map.delete(key);
    else this.map.set(key, existing);
    await this.persist();
  }
}

export const sessionMeta = new SessionMetaStore();
