import type { PreviewSessionSnapshot } from "@t3tools/contracts";

import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";

import { previewBridge } from "./preview/previewBridge";

export type BrowserTabAudioState = "none" | "audible" | "muted";

export interface BrowserTabRuntimeState {
  readonly sessionTabId: string | null;
  readonly runtimeTabId: string | null;
  readonly overlay: DesktopPreviewOverlay | null;
  readonly audio: BrowserTabAudioState;
}

/** Resolve browser-only session, desktop runtime, and audio state in one place. */
export function resolveBrowserTabRuntimeState(input: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
}): BrowserTabRuntimeState {
  const sessionTabId =
    input.surface.kind === "preview" && input.surface.resourceId
      ? (input.sessions[input.surface.resourceId]?.tabId ?? null)
      : null;
  const overlay = sessionTabId ? (input.desktopByTabId[sessionTabId] ?? null) : null;
  const runtimeTabId = sessionTabId ? (input.previewRuntimeTabId?.(sessionTabId) ?? null) : null;
  const audio = !overlay?.audible ? "none" : overlay.audioMuted ? "muted" : "audible";
  return { sessionTabId, runtimeTabId, overlay, audio };
}

/**
 * Label and enabled state for a browser tab's mute menu entry. Overlay state
 * must exist before the desktop tab can safely be addressed.
 */
export function browserTabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

export function setBrowserTabAudioMuted(runtimeTabId: string, muted: boolean): void {
  void previewBridge?.setAudioMuted(runtimeTabId, muted).catch(() => undefined);
}
