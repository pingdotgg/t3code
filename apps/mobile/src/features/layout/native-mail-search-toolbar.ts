import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

/**
 * The patched mail-style toolbar is built natively from iOS 26 Liquid Glass
 * UIKit (`UIGlassEffect`) with no earlier fallback: pre-26 the native side
 * silently drops the item and hides the navigation toolbar entirely. Screens
 * that send it must fall back to standard search/toolbar primitives when this
 * is false.
 */
export const NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED = NATIVE_LIQUID_GLASS_SUPPORTED;

/** Clearance for scroll content that must come to rest above the floating toolbar. */
export const NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET = 56;

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

/**
 * Builds the patched react-native-screens Mail-style bottom search toolbar.
 *
 * Keeping this behind an app-level helper makes the iOS-only RNS patch an
 * explicit layout primitive instead of a per-screen object literal. Android can
 * keep using platform-specific header/search primitives without depending on
 * this helper.
 */
export function createNativeMailSearchToolbarItem(
  input: NativeMailSearchToolbarInput,
): HeaderBarButtonMailSearchToolbarItem {
  return {
    placeholder: "Search",
    ...input,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  };
}
