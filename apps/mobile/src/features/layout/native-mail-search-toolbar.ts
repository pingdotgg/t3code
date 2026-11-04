import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

export const NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED = NATIVE_LIQUID_GLASS_SUPPORTED;

export const NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET = 56;

/** `composeTitle` labels the compose action when the Duo's rail folds it into its More menu. */
export type NativeMailSearchToolbarItem = HeaderBarButtonMailSearchToolbarItem & {
  readonly composeTitle?: string;
};

type NativeMailSearchToolbarInput = Omit<
  NativeMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

export function createNativeMailSearchToolbarItem(
  input: NativeMailSearchToolbarInput,
): NativeMailSearchToolbarItem {
  return {
    placeholder: "Search",
    ...input,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  };
}
