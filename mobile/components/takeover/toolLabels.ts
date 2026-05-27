/**
 * Friendly approval-sheet copy for the visual-feedback MCP tools. The
 * ApprovalSheet receives a tool's qualified name (e.g.
 * `mcp__rove__take_screenshot`) and looks up the user-facing label +
 * prompt body here. Any tool not in this table renders with the
 * existing fallback rendering.
 *
 * Lives in the takeover folder so the handoff SDD can extend the same
 * map with `prepare_preview` later without introducing a parallel
 * lookup.
 */

/**
 * Mobile mirror of the bridge's `SCREENSHOT_MCP_TOOL_QUALIFIED`
 * constant. Kept inline rather than imported to avoid a mobile→bridge
 * type dependency; the format (`mcp__<server>__<tool>`) is dictated by
 * the SDK so it won't drift.
 */
export const SCREENSHOT_MCP_TOOL_QUALIFIED = 'mcp__rove__take_screenshot' as const;
export const PREPARE_PREVIEW_MCP_TOOL_QUALIFIED = 'mcp__rove__prepare_preview' as const;

/** Tools governed by the global `enableVisualFeedback` setting. The
 *  `alwaysAskBeforeCapture` sub-option suppresses "Always allow" only
 *  for these. */
export const VISUAL_FEEDBACK_TOOL_NAMES = [
  SCREENSHOT_MCP_TOOL_QUALIFIED,
  PREPARE_PREVIEW_MCP_TOOL_QUALIFIED,
] as const;

export type VisualFeedbackToolName = (typeof VISUAL_FEEDBACK_TOOL_NAMES)[number];

export function isVisualFeedbackTool(toolName: string): boolean {
  return (VISUAL_FEEDBACK_TOOL_NAMES as readonly string[]).includes(toolName);
}

interface ToolLabel {
  /** Tool name shown in the "Allow X?" headline. */
  label: string;
  /** One-line explanation rendered as the sheet subtitle. */
  summary: string;
}

const TOOL_LABELS: Record<VisualFeedbackToolName, ToolLabel> = {
  [SCREENSHOT_MCP_TOOL_QUALIFIED]: {
    label: 'view your live preview',
    summary:
      'Claude wants to view your live preview to visually verify a change. ' +
      'You will see a brief indicator while it captures.',
  },
  [PREPARE_PREVIEW_MCP_TOOL_QUALIFIED]: {
    label: 'ask you to set up the preview',
    summary:
      'Claude needs help getting the preview to a specific state (logging in, ' +
      'navigating to a screen, etc.) so it can verify a change.',
  },
};

/**
 * Resolve the friendly copy for a tool. Returns `null` when the tool
 * isn't part of the visual-feedback surface, signalling the caller
 * should fall back to the existing default rendering.
 */
export function lookupToolLabel(toolName: string): ToolLabel | null {
  if (isVisualFeedbackTool(toolName)) {
    return TOOL_LABELS[toolName as VisualFeedbackToolName] ?? null;
  }
  return null;
}
