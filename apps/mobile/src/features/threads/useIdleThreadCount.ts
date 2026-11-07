import { useMemo } from "react";

import { useNavigationThreadShells } from "../../state/entities";
import { countIdleThreads } from "./threadListV2";
import { useThreadListNow } from "./use-thread-list-now";

/** Idle threads for the Messages-style count on the thread back button. */
export function useIdleThreadCount(excludeThreadId?: string): number {
  const threads = useNavigationThreadShells();
  const now = useThreadListNow(threads);
  return useMemo(
    () => countIdleThreads(threads, { excludeThreadId, now }),
    [threads, excludeThreadId, now],
  );
}
