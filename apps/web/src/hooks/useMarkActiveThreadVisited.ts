import { useEffect } from "react";

import { useUiStateStore } from "../uiStateStore";

export function useMarkActiveThreadVisited(
  threadKey: string | null,
  latestTurnCompletedAt: string | null,
): void {
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);

  useEffect(() => {
    if (threadKey === null || latestTurnCompletedAt === null) {
      return;
    }
    markThreadVisited(threadKey, latestTurnCompletedAt);
  }, [latestTurnCompletedAt, markThreadVisited, threadKey]);
}
