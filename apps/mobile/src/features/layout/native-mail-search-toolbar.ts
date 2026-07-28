import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "searchText" | "type" | "useFallbackSearchField"
> & {
  readonly value: string;
};

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
  const { value, ...toolbarInput } = input;

  return {
    placeholder: "Search",
    ...toolbarInput,
    searchText: value,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  };
}
