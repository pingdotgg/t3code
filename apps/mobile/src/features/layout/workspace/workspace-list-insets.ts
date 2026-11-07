import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../../native/native-glass";

/** The native bar overlays a workspace list even where it looks solid before iOS 26, so UIKit insets it. */
export const WORKSPACE_LIST_SCROLL_INSETS = {
  automaticallyAdjustsScrollIndicatorInsets: true,
  contentInsetAdjustmentBehavior: "automatic",
} as const;

/** How far an empty workspace list keeps its message below a glass bar and its search. */
export function useWorkspaceListEmptyTopInset(): number {
  const insets = useSafeAreaInsets();
  return NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0;
}
