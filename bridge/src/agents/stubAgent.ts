import { EventEmitter } from 'node:events';
import type { HistoryEntry } from '../types.ts';
import type {
  AgentCapabilities,
  AgentDriver,
  AgentSession,
  DriverSessionListItem,
  PermissionMode,
  ReadHistoryOptions,
} from './types.ts';

const STUB_AGENT_KIND = 'stub';
const STUB_SESSION_ID = '00000000-0000-0000-0000-stubsessionn00';

/**
 * Multi-agent regression fixture. Registered alongside the real claude-code
 * driver when the operator exports `STUB_AGENT=1`. Reports a deliberately
 * minimal capability profile — no permission prompts, no modes, no model
 * selection, no rewind, no fork — so the mobile UI can be exercised to prove
 * none of the chat header / approval / tool-card surfaces hard-code
 * `'claude-code'`.
 *
 * Emits a pre-canned timeline of synthetic events (text, tool_use, tool_result)
 * with tool names like `Echo` and `Sleep` that the claude-code card pack
 * doesn't recognize — those calls render through the generic fallback card.
 */
class StubSession extends EventEmitter implements AgentSession {
  readonly agent = STUB_AGENT_KIND;
  readonly sessionId: string;
  readonly cwd: string;
  lastActivity = Date.now();
  subscribers = 0;
  baselineSha: string | null = null;
  permissionMode: PermissionMode = 'default';
  claimedByBridge = false;
  private _alive = false;
  private turn = 0;

  constructor(sessionId: string, cwd: string) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  get alive(): boolean {
    return this._alive;
  }
  get pid(): number | undefined {
    return undefined;
  }

  capabilities(): AgentCapabilities {
    return {
      agent: this.agent,
      permissionPrompts: false,
      permissionModes: null,
      modelSelection: null,
      fileCheckpointing: false,
      sessionForking: false,
      interrupt: true,
    };
  }

  spawnIfNeeded(): void {
    this._alive = true;
  }

  sendUserMessage(content: string): void {
    if (!this.alive) this.spawnIfNeeded();
    this.lastActivity = Date.now();
    this.turn += 1;
    const turn = this.turn;
    // Pre-canned response sequence — runs on the event loop so subscribers
    // see the same realistic chain of `text → tool_use → tool_result → text`
    // a real agent would produce.
    queueMicrotask(() => {
      this.emit('event', {
        type: 'text',
        role: 'assistant',
        text: `stub agent received: ${content}`,
        messageId: `stub-msg-${turn}-a`,
      });
      const toolUseId = `stub-tool-${turn}`;
      this.emit('event', {
        type: 'tool_use',
        toolUseId,
        name: 'Echo',
        input: { value: content },
      });
      setTimeout(() => {
        this.emit('event', {
          type: 'tool_result',
          toolUseId,
          content: `echoed: ${content}`,
        });
        this.emit('event', {
          type: 'text',
          role: 'assistant',
          text: 'Done.',
          messageId: `stub-msg-${turn}-b`,
        });
        this.emit('event', { type: 'result', subtype: 'success' });
      }, 250);
    });
  }

  sendApproval(): void {
    // Stub never asks for approval — nothing to resolve.
  }

  interrupt(): boolean {
    return false;
  }

  shutdown(): void {
    this._alive = false;
  }
}

export class StubAgentDriver implements AgentDriver {
  readonly kind = STUB_AGENT_KIND;
  readonly displayName = 'Stub Agent';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<DriverSessionListItem[]> {
    return [
      {
        id: STUB_SESSION_ID,
        cwd: '/tmp/stub-agent',
        projectName: 'stub-agent',
        lastModified: Date.now(),
        preview: 'Synthetic test agent for multi-agent UI regression',
        sizeBytes: 0,
        desktopPids: [],
      },
    ];
  }

  async findSession(id: string): Promise<{ cwd: string; path?: string } | null> {
    if (id !== STUB_SESSION_ID) return null;
    return { cwd: '/tmp/stub-agent' };
  }

  async readHistory(_id: string, _opts?: ReadHistoryOptions): Promise<HistoryEntry[]> {
    return [];
  }

  createSession(id: string, cwd: string): AgentSession {
    return new StubSession(id, cwd);
  }

  async getDesktopPids(): Promise<number[]> {
    return [];
  }
}
