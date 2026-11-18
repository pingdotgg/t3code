import { msg, useMessages } from "gt-react-native";
import { useWindowDimensions } from "react-native";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

export const NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED = NATIVE_LIQUID_GLASS_SUPPORTED;

export const NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET = 56;

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

/**
 * Describe the thread-list search and actions for the native header adapter.
 */
export function useCreateNativeMailSearchToolbarItem() {
  const { fontSize } = useScaledTextRole("body");
  const { fontScale } = useWindowDimensions();
  const resolve = useMessages();
  return (
    input: NativeMailSearchToolbarInput,
  ): HeaderBarButtonMailSearchToolbarItem & { searchFontSize: number } => ({
    placeholder: resolve(msg("Search")),
    searchFontSize: fontSize * fontScale,
    ...input,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  });
}
