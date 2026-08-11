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

import { getHydratedClientSettings } from "./hooks/useSettings";
import { useRightPanelStore } from "./rightPanelStore";
import { useTerminalUiStateStore } from "./terminalUiStateStore";

// The chats this defaulting has already decided on. Both stores drop a thread's
// entry once its layout returns to the all-closed default, so store contents
// alone cannot tell an untouched chat from one the user emptied on purpose.
//
// The record is per session. A draft the user emptied and then reloaded is
// defaulted one more time, because nothing else survives that reload either:
// the stores persist the emptied layout as no entry at all, and the terminal
// store keeps its closed ids out of what it persists. Holding the decision
// durably would mean carrying a marker per draft through the persisted composer
// draft schema, which is a bigger change than the miss is worth.
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

export async function applyNewThreadPanelDefaults(threadRef: ScopedThreadRef): Promise<void> {
  // Client settings hydrate asynchronously and read as the defaults — both of
  // these off — until that lands. The index route opens its draft inside that
  // window, so reading the snapshot directly would skip the first chat of the
  // session and never come back to it.
  const settings = await getHydratedClientSettings();
  // "New chat" hands back an unused draft rather than minting one whenever it
  // can, so the defaults must never re-force a layout: whatever that draft
  // already has wins, including a panel the user deliberately closed. Recording
  // the chat before acting on it keeps that true once the stores have forgotten
  // an emptied layout — the decision is made once per chat, not once per press.
  // An all-closed decision counts too: a chat first opened while both defaults
  // were off is decided all-closed, so enabling a default later does not open a
  // panel in that already-shaped draft.
  const threadKey = scopedThreadKey(threadRef);
  if (decidedThreadKeys.has(threadKey)) return;
  decidedThreadKeys.add(threadKey);
  if (!settings.newThreadOpenFilesPanel && !settings.newThreadOpenTerminal) return;
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
