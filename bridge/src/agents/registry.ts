import { ClaudeCodeSdkDriver } from './claudeCodeSdk.ts';
import { StubAgentDriver } from './stubAgent.ts';
import type { AgentDriver, AgentKind, AgentMetadata, DriverSessionListItem } from './types.ts';

const drivers = new Map<AgentKind, AgentDriver>();

function register(driver: AgentDriver): void {
  drivers.set(driver.kind, driver);
}

const STUB_AGENT_ENV = 'STUB_AGENT';

// The SDK is the only claude-code transport — in-process via
// `@anthropic-ai/claude-agent-sdk` (no spawn, no MCP subprocess, live mode/
// model swap, native rewind/fork, FileChanged hook).
register(new ClaudeCodeSdkDriver());

// Multi-agent regression fixture. Opt-in (no impact on production builds) —
// when enabled, registers a stub agent with a deliberately different
// capability profile so the mobile UI can be exercised against an agent that
// has no permission prompts, no mode picker, no model selection, no rewind,
// no fork.
if ((process.env[STUB_AGENT_ENV] ?? '') === '1') {
  console.log(`[registry] stub agent enabled (${STUB_AGENT_ENV}=1)`);
  register(new StubAgentDriver());
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
