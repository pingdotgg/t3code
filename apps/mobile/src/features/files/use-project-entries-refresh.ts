import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";

export function useProjectEntriesRefresh(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): { readonly isRefreshing: boolean; readonly refresh: () => void } {
  const runRefresh = useAtomCommand(projectEnvironment.refreshEntries);
  const requestIdRef = useRef(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    setIsRefreshing(false);
    return () => {
      requestIdRef.current += 1;
    };
  }, [cwd, environmentId]);

  const refresh = useCallback(() => {
    if (environmentId === null || cwd === null) return;
    const requestId = ++requestIdRef.current;
    setIsRefreshing(true);
    void runRefresh({ environmentId, input: { cwd } }).finally(() => {
      if (requestIdRef.current === requestId) {
        setIsRefreshing(false);
      }
    });
  }, [cwd, environmentId, runRefresh]);

  return { isRefreshing, refresh };
}
