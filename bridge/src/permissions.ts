import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, runtimeState } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(HERE, 'mcp', 'permission-server.ts');

function resolveTsxBin(): string {
  // Prefer the workspace-local tsx so spawned children don't have to inherit PATH.
  const local = resolve(HERE, '..', '..', 'node_modules', '.bin', 'tsx');
  if (existsSync(local)) return local;
  return 'tsx';
}

export interface PermissionRequest {
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface Pending {
  resolve: (res: PermissionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Original tool input — echoed back as `updatedInput` when the user allows. */
  input: unknown;
}

class PermissionRegistry {
  private pendingByKey = new Map<string, Pending>();
  private internalTokenValue: string;

  constructor() {
    this.internalTokenValue = randomUUID();
  }

  /** Token shared between bridge and the MCP permission server it spawns. */
  internalToken(): string {
    return this.internalTokenValue;
  }

  private key(agent: string, sessionId: string, toolUseId: string): string {
    return `${agent}::${sessionId}::${toolUseId}`;
  }

  /**
   * Called from the bridge's /internal/permission endpoint when the MCP server
   * forwards a request. Returns a promise that resolves when the phone responds.
   */
  await(agent: string, sessionId: string, req: PermissionRequest, timeoutMs = 120_000): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve, reject) => {
      const k = this.key(agent, sessionId, req.toolUseId);
      const timer = setTimeout(() => {
        this.pendingByKey.delete(k);
        reject(new Error(`permission_prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingByKey.set(k, { resolve, reject, timer, input: req.input });
    });
  }

  /** Called from the WS `approval` handler when the user taps Allow/Deny. */
  resolve(agent: string, sessionId: string, toolUseId: string, decision: 'allow' | 'allow_always' | 'deny'): boolean {
    const k = this.key(agent, sessionId, toolUseId);
    const pending = this.pendingByKey.get(k);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingByKey.delete(k);
    if (decision === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'denied by user' });
    } else {
      // Claude requires `updatedInput` to be an object. Echo the original input
      // (unmodified) so the tool runs as proposed.
      const updatedInput =
        pending.input && typeof pending.input === 'object'
          ? (pending.input as Record<string, unknown>)
          : {};
      pending.resolve({ behavior: 'allow', updatedInput });
    }
    return true;
  }

  isInternalAuth(headerToken: string | undefined): boolean {
    return !!headerToken && headerToken === this.internalTokenValue;
  }
}

export const permissions = new PermissionRegistry();

export function getMcpConfig(extraEnv?: Record<string, string>): string {
  // Inline MCP config — claude will spawn the permission server with these env vars.
  // Absolute paths so claude (whose cwd is the session's project dir) can find them.
  //
  // We prefer the .ts.net hostname when available because our Let's Encrypt cert
  // is issued to it — TLS validates cleanly without skipping checks. Fall back
  // to the bind IP (works, but MCP server's node:https still has
  // rejectUnauthorized:false for the cert-vs-IP hostname mismatch), then to
  // loopback for non-tailscale dev setups.
  const scheme = runtimeState.urlScheme;
  const bridgeHost =
    runtimeState.tailscaleHostname ?? runtimeState.bindHost ?? '127.0.0.1';
  const env: Record<string, string> = {
    ...extraEnv,
    BRIDGE_INTERNAL_URL: `${scheme}://${bridgeHost}:${config.port}`,
    BRIDGE_INTERNAL_TOKEN: permissions.internalToken(),
  };

  const conf = {
    mcpServers: {
      rove: {
        command: resolveTsxBin(),
        args: [MCP_SERVER_PATH],
        env,
      },
    },
  };
  return JSON.stringify(conf);
}
