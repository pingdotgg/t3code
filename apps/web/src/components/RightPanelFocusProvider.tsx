import type { ReactNode } from "react";

import { RightPanelFocusScopeContext } from "./rightPanelFocusScope";

export function RightPanelFocusProvider({ children }: { children: ReactNode }) {
  return (
    <RightPanelFocusScopeContext.Provider value>{children}</RightPanelFocusScopeContext.Provider>
  );
}
