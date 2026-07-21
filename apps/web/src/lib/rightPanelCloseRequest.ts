import type { RightPanelKind } from "../rightPanelStore";
import type { CloseFocusOwner } from "./closeFocus";

export const CLOSE_FOCUSED_REGION_EVENT = "t3:close-focused-region";

export type CloseRequestTarget = "drawer-terminal" | "right-panel" | "right-panel-terminal";

export function resolveCloseRequestTarget({
  focusOwner,
  drawerTerminalOpen,
  rightPanelOpen,
  rightPanelSurfaceKind,
}: {
  readonly focusOwner: CloseFocusOwner | null;
  readonly drawerTerminalOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly rightPanelSurfaceKind: RightPanelKind | null;
}): CloseRequestTarget | null {
  if (focusOwner === "drawer-terminal") {
    return drawerTerminalOpen ? "drawer-terminal" : null;
  }
  if (focusOwner !== "right-panel" || !rightPanelOpen) return null;
  return rightPanelSurfaceKind === "terminal" ? "right-panel-terminal" : "right-panel";
}

export function shouldHandleCloseRequest(
  target: CloseRequestTarget,
  command: string | null,
): boolean {
  if (target === "drawer-terminal") return command === "terminal.close";
  return (
    command === "rightPanel.closeActiveSurface" ||
    (target === "right-panel-terminal" && command === "terminal.close")
  );
}

export function requestCloseFocusedRegion(target: Pick<Window, "dispatchEvent"> = window): boolean {
  const event = new Event(CLOSE_FOCUSED_REGION_EVENT, {
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
