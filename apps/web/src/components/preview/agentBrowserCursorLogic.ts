export type BrowserController = "human" | "agent" | "none";

export const AGENT_CURSOR_FOLLOW_MS = 180;

export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

export function easeOutCubic(amount: number): number {
  const t = Math.min(1, Math.max(0, amount));
  return 1 - (1 - t) ** 3;
}

/** Shown next to the pointer only while it is moving or clicking. */
export function agentBrowserCursorLabel(
  phase: "move" | "click",
  active: boolean,
): "Agent" | "Click" | null {
  if (!active) return null;
  return phase === "click" ? "Click" : "Agent";
}
