import { createContext, use } from "react";

export const InterfaceDirectionContext = createContext<"ltr" | "rtl">("ltr");

export function useInterfaceDirection() {
  return use(InterfaceDirectionContext);
}
