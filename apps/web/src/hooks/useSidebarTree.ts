import { useCallback } from "react";
import { installSidebarTree } from "../lib/sidebarTree";
import { useAccessibilitySupport } from "./useAccessibilitySupport";

export function useSidebarTree() {
  const accessible = useAccessibilitySupport();
  const ref = useCallback((element: HTMLElement | null) => {
    if (element) return installSidebarTree(element);
  }, []);
  return {
    ref,
    role: "tree",
    "aria-label": "Threads",
    "aria-description": accessible
      ? "Use arrow keys to browse, Right and Left to expand or collapse, and Enter to open. F2 enters row actions; Escape returns to the row."
      : undefined,
  } as const;
}
