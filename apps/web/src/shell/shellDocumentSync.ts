import { DIFF_PANEL_STORAGE_KEY, useDiffPanelStore } from "../diffPanelStore";
import { RIGHT_PANEL_STORAGE_KEY, useRightPanelStore } from "../rightPanelStore";
import { TERMINAL_UI_STATE_STORAGE_KEY, useTerminalUiStateStore } from "../terminalUiStateStore";
import { syncStoreAcrossDocuments } from "./crossDocumentStoreSync";

/** Keeps the panel-related stores converged between the primary and embed documents. */
export function enableShellDocumentSync(): void {
  syncStoreAcrossDocuments(useRightPanelStore, RIGHT_PANEL_STORAGE_KEY);
  syncStoreAcrossDocuments(useTerminalUiStateStore, TERMINAL_UI_STATE_STORAGE_KEY);
  syncStoreAcrossDocuments(useDiffPanelStore, DIFF_PANEL_STORAGE_KEY);
}
