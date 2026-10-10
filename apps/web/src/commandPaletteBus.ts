import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Element id of the mounted palette popup. An id lookup is O(1); keydown handlers call this per key. */
export const COMMAND_PALETTE_ELEMENT_ID = "t3-command-palette";

let commandPaletteRequested = false;

/** The palette host marks an open as soon as it is requested, before the dialog's chunk loads. */
export function setCommandPaletteRequested(requested: boolean): void {
  commandPaletteRequested = requested;
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    commandPaletteRequested ||
    (typeof document !== "undefined" &&
      document.getElementById(COMMAND_PALETTE_ELEMENT_ID) !== null)
  );
}
