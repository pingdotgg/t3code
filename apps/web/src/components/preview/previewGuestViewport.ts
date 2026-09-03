import type { PreviewViewportSetting } from "@t3tools/contracts";

export type PreviewGuestViewportOverride =
  | { readonly clear: true }
  | { readonly width: number; readonly height: number };

export type PreviewGuestViewportApplier = (
  tabId: string,
  input: PreviewGuestViewportOverride,
) => Promise<void>;

/** Maps a stored CSS viewport setting onto the desktop bridge input. */
export function previewGuestViewportOverride(
  setting: PreviewViewportSetting,
): PreviewGuestViewportOverride {
  if (setting._tag === "fill") return { clear: true };
  return {
    width: setting.width,
    height: setting.height,
  };
}

/** Applies or clears the guest CDP metrics override. No-op on older desktops. */
export async function applyPreviewGuestViewport(
  setViewport: PreviewGuestViewportApplier | undefined,
  tabId: string,
  setting: PreviewViewportSetting,
): Promise<void> {
  if (!setViewport) return;
  await setViewport(tabId, previewGuestViewportOverride(setting));
}
