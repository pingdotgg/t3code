import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";
import { focusTerminalOnNavigation } from "./terminalFocus";

export function revealThreadTerminal(threadRef: ScopedThreadRef, terminalId: string) {
  useRightPanelStore.getState().openTerminal(threadRef, terminalId);
  focusTerminalOnNavigation(threadRef, terminalId);
}
