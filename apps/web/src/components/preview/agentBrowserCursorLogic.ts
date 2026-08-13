export type BrowserController = "human" | "agent" | "none";

export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}

/** Shown next to the pointer only while it is moving or clicking. */
export function agentBrowserCursorLabel(
  phase: "move" | "click",
  active: boolean,
): "Agent" | "Click" | null {
  if (!active) return null;
  return phase === "click" ? "Click" : "Agent";
}
