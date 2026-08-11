/**
 * Default panel layout for new project chats.
 *
 * A new chat opens with the panels the user asked for in Settings instead of a
 * bare chat column. Both panel stores are keyed by the draft's pre-allocated
 * thread ref, so the seeded layout carries over unchanged when the server
 * thread materializes on first send.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { useRightPanelStore } from "./rightPanelStore";
import { useTerminalUiStateStore } from "./terminalUiStateStore";

export type NewThreadPanelDefaults = Pick<
  ClientSettings,
  "newThreadOpenFilesPanel" | "newThreadOpenTerminal"
>;

// The chats this defaulting has already decided on. Both stores drop a thread's
// entry once its layout returns to the all-closed default, so store contents
// alone cannot tell an untouched chat from one the user emptied on purpose.
const decidedThreadKeys = new Set<string>();

// A layout the user has already shaped: an entry in either store, or a terminal
// they closed — closing the last one drops the thread's now-default UI state but
// keeps the closed id suppressed.
function hasPanelState(threadKey: string): boolean {
  const terminalUiState = useTerminalUiStateStore.getState();
  return (
    threadKey in useRightPanelStore.getState().byThreadKey ||
    threadKey in terminalUiState.terminalUiStateByThreadKey ||
    threadKey in terminalUiState.suppressedTerminalIdsByThreadKey
  );
}

export function applyNewThreadPanelDefaults(
  threadRef: ScopedThreadRef,
  settings: NewThreadPanelDefaults,
): void {
  if (!settings.newThreadOpenFilesPanel && !settings.newThreadOpenTerminal) return;
  // "New chat" hands back an unused draft rather than minting one whenever it
  // can, so the defaults must never re-force a layout: whatever that draft
  // already has wins, including a panel the user deliberately closed. Recording
  // the chat before acting on it keeps that true once the stores have forgotten
  // an emptied layout — the decision is made once per chat, not once per press.
  const threadKey = scopedThreadKey(threadRef);
  if (decidedThreadKeys.has(threadKey)) return;
  decidedThreadKeys.add(threadKey);
  if (hasPanelState(threadKey)) return;
  if (settings.newThreadOpenFilesPanel) {
    useRightPanelStore.getState().open(threadRef, "files");
  }
  if (settings.newThreadOpenTerminal) {
    // Opening with no sessions seeds the default terminal id; the drawer
    // attaches it on mount, and attaching an unknown id opens the PTY in the
    // project's cwd.
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
  }
}
