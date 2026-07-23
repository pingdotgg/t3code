import type { ScopedProjectRef } from "@t3tools/contracts";

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";
const COMMAND_PALETTE_CLOSE_EVENT = "t3code:close-command-palette";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly preferredProjectRef?: ScopedProjectRef | null;
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

export function closeCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_CLOSE_EVENT));
}

export function onCloseCommandPalette(listener: () => void): () => void {
  window.addEventListener(COMMAND_PALETTE_CLOSE_EVENT, listener);
  return () => window.removeEventListener(COMMAND_PALETTE_CLOSE_EVENT, listener);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
