import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

/**
 * Builds the patched react-native-screens Mail-style bottom search toolbar.
 *
 * Keeping this behind an app-level helper makes the iOS-only RNS patch an
 * explicit layout primitive instead of a per-screen object literal. Android can
 * keep using Expo Router toolbar primitives without depending on this helper.
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
