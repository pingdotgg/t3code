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

// Both stores drop a thread's entry once it returns to the all-closed default,
// so a key present in either one means this chat already has a layout.
function hasPanelState(threadRef: ScopedThreadRef): boolean {
  const threadKey = scopedThreadKey(threadRef);
  return (
    threadKey in useRightPanelStore.getState().byThreadKey ||
    threadKey in useTerminalUiStateStore.getState().terminalUiStateByThreadKey
  );
}

export function applyNewThreadPanelDefaults(
  threadRef: ScopedThreadRef,
  settings: NewThreadPanelDefaults,
): void {
  if (!settings.newThreadOpenFilesPanel && !settings.newThreadOpenTerminal) return;
  // "New chat" hands back an unused draft rather than minting one whenever it
  // can, so the defaults must never re-force a layout: whatever that draft
  // already has wins, including a panel the user deliberately closed.
  if (hasPanelState(threadRef)) return;
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
