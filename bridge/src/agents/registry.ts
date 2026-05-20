import { ClaudeCodeDriver } from './claudeCode.ts';
import { ClaudeCodeSdkDriver } from './claudeCodeSdk.ts';
import type { AgentDriver, AgentKind, AgentMetadata, DriverSessionListItem } from './types.ts';

const drivers = new Map<AgentKind, AgentDriver>();

function register(driver: AgentDriver): void {
  drivers.set(driver.kind, driver);
}

// Pick the claude-code driver implementation: CLI (default) or SDK (opt-in).
// CLAUDE_DRIVER=sdk swaps to the @anthropic-ai/claude-agent-sdk-backed driver
// — same sessions, same auth, but runtime mode/interrupt control (no process
// kill on mode change). Set CLAUDE_DRIVER=cli or leave unset for the original.
const useSdk = (process.env.CLAUDE_DRIVER ?? '').toLowerCase() === 'sdk';
if (useSdk) {
  console.log('[registry] claude-code driver: SDK (@anthropic-ai/claude-agent-sdk)');
  register(new ClaudeCodeSdkDriver());
} else {
  register(new ClaudeCodeDriver());
}

export function getDriver(kind: AgentKind): AgentDriver | undefined {
  return drivers.get(kind);
}

export function listDrivers(): AgentDriver[] {
  return Array.from(drivers.values());
}

export async function listAgents(): Promise<AgentMetadata[]> {
  const out: AgentMetadata[] = [];
  for (const driver of drivers.values()) {
    out.push({ kind: driver.kind, displayName: driver.displayName, available: await driver.isAvailable() });
  }
  return out;
}

export interface CrossAgentSessionListItem extends DriverSessionListItem {
  agent: AgentKind;
}

export async function listAllSessions(): Promise<CrossAgentSessionListItem[]> {
  const out: CrossAgentSessionListItem[] = [];
  for (const driver of drivers.values()) {
    try {
      const sessions = await driver.listSessions();
      for (const s of sessions) out.push({ ...s, agent: driver.kind });
    } catch (err) {
      console.error(`[registry] driver ${driver.kind} listSessions failed:`, (err as Error).message);
    }
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}
