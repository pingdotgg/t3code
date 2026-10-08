import { clampMcpAppHeight } from "@t3tools/shared/mcpApp";

/** Taller apps scroll inside the inline view; full screen fills its own screen. */
export const MCP_APP_INLINE_MAX_HEIGHT = 420;

export function mcpAppInlineHeight(height: number | undefined): number | undefined {
  if (height === undefined || !Number.isFinite(height)) return undefined;
  return Math.min(MCP_APP_INLINE_MAX_HEIGHT, clampMcpAppHeight(height));
}
