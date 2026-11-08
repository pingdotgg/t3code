import { useMemo } from "react";

import { useNavigationThreadShells } from "../../state/entities";
import { countIdleThreads } from "./threadListV2";
import { useThreadListNow } from "./use-thread-list-now";

/** Idle threads for the Messages-style count on the thread back button. */
export function useIdleThreadCount(exclude?: {
  readonly environmentId: string;
  readonly threadId: string;
}): number {
  const threads = useNavigationThreadShells();
  const now = useThreadListNow(threads);
  const excludeEnvironmentId = exclude?.environmentId;
  const excludeThreadId = exclude?.threadId;
  return useMemo(
    () =>
      countIdleThreads(threads, {
        now,
        excludeThread:
          excludeEnvironmentId !== undefined && excludeThreadId !== undefined
            ? { environmentId: excludeEnvironmentId, threadId: excludeThreadId }
            : undefined,
      }),
    [threads, excludeEnvironmentId, excludeThreadId, now],
  );
}
