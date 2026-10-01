import { BROWSER_SURFACE_OVERLAY_ATTRIBUTE } from "@t3tools/extension-sdk/catalogue";

/**
 * Stacking for the panel's UI that floats over the composited page, from the
 * slot's `overlayZIndex`. The device chrome sits on the overlay layer, and
 * transient UI one layer above it: the zoom pill in place, as native's sits
 * in the page area. The page menu goes to the host's floating layer, above
 * all of them, as native menus do; on hosts without one it renders in place
 * on the transient layer.
 */
export function floatingLayers(overlayZIndex: number) {
  return { deviceChrome: overlayZIndex, transient: overlayZIndex + 1 } as const;
}

/**
 * Spread onto every element that floats over the page: the slot's occlusion
 * probe then keeps the page presented beneath it, as native does under its
 * own menus.
 */
export const floatingOverPage = { [BROWSER_SURFACE_OVERLAY_ATTRIBUTE]: "" } as const;
