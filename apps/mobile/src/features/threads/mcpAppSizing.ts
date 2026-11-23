import { clampMcpAppHeight } from "@t3tools/shared/mcpApp";

export const MCP_APP_INLINE_INITIAL_HEIGHT = 420;
/** An answered quiz question with its explanation fits. */
export const MCP_APP_INLINE_MAX_HEIGHT = 640;

export function mcpAppInlineHeight(height: number | undefined): number | undefined {
  if (height === undefined || !Number.isFinite(height)) return undefined;
  return Math.min(MCP_APP_INLINE_MAX_HEIGHT, clampMcpAppHeight(height));
}
