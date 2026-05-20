import type { AgentKind } from '@/lib/types';
import { claudeCodeCards, renderGenericCard } from './claudeCode';
import type { ToolCardRenderer } from './types';

interface CardPack {
  agent: AgentKind;
  cards: Record<string, ToolCardRenderer>;
}

/**
 * Per-agent tool card pack registry. The chat container looks up renderers
 * via `pickToolCard(agent, toolName)` without ever string-comparing the
 * agent kind itself — keeping the chat container agent-neutral.
 *
 * Adding a new agent is a one-line change here: import its pack and add
 * the entry. Any tool the pack doesn't cover falls through to the generic
 * fallback renderer, so unknown tools (or future Claude tools we haven't
 * written cards for) render cleanly.
 */
const packs: Record<string, CardPack> = {
  'claude-code': { agent: 'claude-code', cards: claudeCodeCards },
};

export function pickToolCard(agent: AgentKind, toolName: string): ToolCardRenderer {
  return packs[agent]?.cards[toolName] ?? renderGenericCard;
}
