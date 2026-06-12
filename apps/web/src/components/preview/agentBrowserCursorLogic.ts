export type BrowserController = "human" | "agent" | "none";

export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}
