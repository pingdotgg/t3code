import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../../native/native-glass";

/** How far an empty workspace list keeps its message below a glass bar and its search. */
export function useWorkspaceListEmptyTopInset(): number {
  const insets = useSafeAreaInsets();
  return NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0;
}
