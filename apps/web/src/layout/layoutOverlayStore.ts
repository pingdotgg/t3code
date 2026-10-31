import { create } from "zustand";

/**
 * "hold": the compact layout menu while alt+cmd stays held, gone on release.
 * "sheet": every shortcut, pinned by cmd+/ until Escape or a press outside.
 */
export type LayoutOverlayMode = "hold" | "sheet";

export const useLayoutOverlayStore = create<{ mode: LayoutOverlayMode | null }>(() => ({
  mode: null,
}));

export function setLayoutOverlayMode(mode: LayoutOverlayMode | null): void {
  if (useLayoutOverlayStore.getState().mode !== mode) useLayoutOverlayStore.setState({ mode });
}

/** cmd+/ and the palette: pin the full shortcut sheet, or close it. */
export function toggleLayoutShortcutSheet(): void {
  setLayoutOverlayMode(useLayoutOverlayStore.getState().mode === "sheet" ? null : "sheet");
}
