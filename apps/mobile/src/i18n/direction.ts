import { createContext, use } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const InterfaceDirectionContext = createContext<"ltr" | "rtl">("ltr");

export function useInterfaceDirection() {
  return use(InterfaceDirectionContext);
}

export function useStartSafeAreaInset() {
  const insets = useSafeAreaInsets();
  return useInterfaceDirection() === "rtl" ? insets.right : insets.left;
}
