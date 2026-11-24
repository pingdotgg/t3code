import { clampMcpAppHeight } from "@t3tools/shared/mcpApp";

export const MCP_APP_INLINE_MAX_HEIGHT = 420;

export function mcpAppContentHeight(height: number | undefined): number | undefined {
  if (height === undefined || !Number.isFinite(height)) return undefined;
  return clampMcpAppHeight(height);
}

/** Taller apps scroll inside the inline view, framed so the cut edge is visible. */
export function mcpAppInlineFrame(contentHeight: number) {
  return {
    height: Math.min(MCP_APP_INLINE_MAX_HEIGHT, contentHeight),
    clipped: contentHeight > MCP_APP_INLINE_MAX_HEIGHT,
  };
}
