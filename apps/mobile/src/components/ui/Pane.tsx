import { createContext, use } from "react";

/** Which workspace column a screen renders in. Sheets and full-screen overlays are in none. */
export type PaneRole = "sidebar" | "content" | "inspector";

export const PaneContext = createContext<PaneRole | null>(null);

export function usePaneRole() {
  return use(PaneContext);
}
