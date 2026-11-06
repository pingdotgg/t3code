import { useEffect, useRef } from "react";

import type { WorkspaceSearchMode } from "./workspace-tabs-state";

export function useSearchScrollRestoration(
  searchMode: WorkspaceSearchMode | undefined,
  restore: () => void,
) {
  const previousSearchMode = useRef(searchMode);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the native list's saved search position
  useEffect(() => {
    const cancelledSearch =
      previousSearchMode.current !== undefined &&
      previousSearchMode.current !== "resting" &&
      searchMode === "resting";
    previousSearchMode.current = searchMode;
    if (cancelledSearch) restore();
  }, [searchMode, restore]);
}
