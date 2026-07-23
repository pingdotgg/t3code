import { useLayoutEffect } from "react";

import { handleSelectionNavigationKeyDown } from "../selectionNavigation";

export function SelectionNavigationBindings() {
  useLayoutEffect(() => {
    window.addEventListener("keydown", handleSelectionNavigationKeyDown, true);
    return () => window.removeEventListener("keydown", handleSelectionNavigationKeyDown, true);
  }, []);

  return null;
}
