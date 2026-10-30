import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { focusTerminal, type TerminalFocusOwner } from "./terminalFocus";

export function cycleThreadTerminal(
  threadRef: ScopedThreadRef,
  owner: TerminalFocusOwner,
  direction: "previous" | "next",
): boolean {
  const drawer = useTerminalUiStateStore.getState();
  const panels = useRightPanelStore.getState();
  const drawerState = selectThreadTerminalUiState(drawer.terminalUiStateByThreadKey, threadRef);
  const panelState = selectThreadRightPanelState(panels.byThreadKey, threadRef);
  const activeSurface = panelState.surfaces.find(
    (surface) => surface.id === panelState.activeSurfaceId,
  );
  const terminalIds =
    owner === "drawer"
      ? drawerState.terminalGroups.flatMap((group) => group.terminalIds)
      : panelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        );
  const activeTerminalId =
    owner === "drawer"
      ? drawerState.activeTerminalId
      : activeSurface?.kind === "terminal"
        ? activeSurface.activeTerminalId
        : null;
  const index = activeTerminalId === null ? -1 : terminalIds.indexOf(activeTerminalId);
  if (index === -1 || (owner === "drawer" ? !drawerState.terminalOpen : !panelState.isOpen))
    return false;
  const offset = direction === "next" ? 1 : -1;
  const terminalId = terminalIds[(index + offset + terminalIds.length) % terminalIds.length];
  if (terminalId === undefined) return false;
  if (owner === "drawer") {
    drawer.setActiveTerminal(threadRef, terminalId);
  } else {
    const surface = panelState.surfaces.find(
      (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
    );
    if (!surface) return false;
    panels.activateTerminal(threadRef, surface.id, terminalId);
    panels.activateSurface(threadRef, surface.id);
  }
  focusTerminal(threadRef, terminalId);
  return true;
}
