import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useInterfaceDirection } from "./direction";

export function useStartSafeAreaInset() {
  const insets = useSafeAreaInsets();
  return useInterfaceDirection() === "rtl" ? insets.right : insets.left;
}
