import type { ReactNode } from 'react';
import type { Theme } from '@/theme';
import type { AgentKind } from '@/lib/types';

/** Context handed to every tool card renderer. The chat container passes the
 *  session's `agent` so per-agent packs can branch on it if needed, plus the
 *  resolved theme so renderers don't pull `useTheme` themselves. */
export interface ToolCardContext {
  agent: AgentKind;
  name: string;
  input: unknown;
  running?: boolean;
  t: Theme;
}

export type ToolCardRenderer = (ctx: ToolCardContext) => ReactNode;
