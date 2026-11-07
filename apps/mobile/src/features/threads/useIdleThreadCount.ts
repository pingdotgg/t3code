import { useMemo } from "react";

import { useNavigationThreadShells } from "../../state/entities";
import { countIdleThreads } from "./threadListV2";

/** Idle threads for the Messages-style count on the thread back button. */
export function useIdleThreadCount(excludeThreadId?: string): number {
  const threads = useNavigationThreadShells();
  return useMemo(() => countIdleThreads(threads, { excludeThreadId }), [threads, excludeThreadId]);
}
