import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RegisteredDevice {
  /** Expo push token, like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] */
  token: string;
  /** Optional friendly label set by the mobile client. */
  label?: string;
  /** Optional platform hint ('ios' | 'android'). */
  platform?: string;
  /** Registration timestamp (ms). */
  registeredAt: number;
}

const STORE_PATH = join(homedir(), '.rove', 'devices.json');

class DeviceRegistry {
  private devices: Map<string, RegisteredDevice> = new Map();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as RegisteredDevice[];
      for (const d of parsed) if (d.token) this.devices.set(d.token, d);
    } catch {
      // First run / no file. Fine.
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(STORE_PATH), { recursive: true });
      await writeFile(STORE_PATH, JSON.stringify([...this.devices.values()], null, 2), 'utf8');
    } catch (err) {
      console.error('[devices] failed to persist:', (err as Error).message);
    }
  }

  async register(token: string, opts: { label?: string; platform?: string } = {}): Promise<void> {
    await this.load();
    const existing = this.devices.get(token);
    this.devices.set(token, {
      token,
      label: opts.label ?? existing?.label,
      platform: opts.platform ?? existing?.platform,
      registeredAt: existing?.registeredAt ?? Date.now(),
    });
    await this.persist();
  }

  async unregister(token: string): Promise<boolean> {
    await this.load();
    const removed = this.devices.delete(token);
    if (removed) await this.persist();
    return removed;
  }

  async list(): Promise<RegisteredDevice[]> {
    await this.load();
    return [...this.devices.values()];
  }

  /**
   * Fire-and-forget Expo push to every registered device.
   * Failures are logged but don't throw — the result event must still propagate.
   */
  async pushToAll(payload: { title: string; body: string; data?: Record<string, unknown> }): Promise<void> {
    await this.load();
    if (this.devices.size === 0) return;
    const messages = [...this.devices.values()]
      .filter((d) => d.token.startsWith('ExponentPushToken'))
      .map((d) => ({
        to: d.token,
        sound: 'default',
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
      }));
    if (messages.length === 0) return;
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        console.error(`[devices] expo push returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return;
      }
      const body = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
      // Prune tokens Expo tells us are dead.
      if (Array.isArray(body.data)) {
        body.data.forEach((entry, i) => {
          if (entry.status === 'error') {
            const code = entry.details?.error;
            const token = messages[i]?.to;
            if (token && (code === 'DeviceNotRegistered' || code === 'InvalidCredentials')) {
              this.devices.delete(token);
              console.log(`[devices] pruning dead token (${code})`);
            } else if (entry.message) {
              console.error(`[devices] push error for ${token?.slice(0, 30)}: ${entry.message}`);
            }
          }
        });
        await this.persist();
      }
    } catch (err) {
      console.error('[devices] push failed:', (err as Error).message);
    }
  }
}

export const devices = new DeviceRegistry();
