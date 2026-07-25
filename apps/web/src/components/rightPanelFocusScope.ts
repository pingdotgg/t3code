import { createContext, useContext } from "react";

export const RightPanelFocusScopeContext = createContext(false);

export function useRightPanelFocusScope(): boolean {
  return useContext(RightPanelFocusScopeContext);
}
