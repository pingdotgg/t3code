import type { ScopedThreadRef } from "@t3tools/contracts";

import { isElectron } from "../env";
import type { ShortcutMatchContext } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

export interface CommandContextInput {
  readonly threadRef?: ScopedThreadRef | null;
  readonly pathname?: string;
  readonly overrides?: Partial<ShortcutMatchContext>;
}

/**
 * Snapshot of when-clause context for palette enablement and command dispatch.
 * Pass route thread/pathname from React; DOM focus probes fill the rest.
 */
export function readCommandContext(input: CommandContextInput = {}): ShortcutMatchContext {
  const threadRef = input.threadRef ?? null;
  const pathname =
    input.pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const terminalOpen = threadRef
    ? selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalOpen
    : false;
  const activeRightPanel = threadRef
    ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)
    : null;

  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen,
    previewFocus: isPreviewFocused(),
    previewOpen: activeRightPanel === "preview",
    rightPanelOpen: activeRightPanel !== null,
    usagePageOpen: pathname === "/usage",
    modelPickerOpen: isModelPickerOpen(),
    editableFocus: isEditableFocused(
      typeof document !== "undefined" ? document.activeElement : null,
    ),
    isWeb: !isElectron,
    isDesktop: isElectron,
    ...input.overrides,
  };
}
