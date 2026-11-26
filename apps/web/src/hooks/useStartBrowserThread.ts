import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";
import { usePrimaryEnvironment } from "../state/environments";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

/**
 * Starts a scratch thread with its browser panel maximized, for a link opened outside any thread.
 * `onFailure` runs when no thread could start; the scratch project reports its own failures.
 */
export function useStartBrowserThread() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  return async (failureTitle: string, onFailure: () => void): Promise<ScopedThreadRef | null> => {
    const environmentId = scratchEnvironmentId(primaryEnvironment?.environmentId ?? null);
    if (environmentId === null) {
      onFailure();
      return null;
    }
    const project = await openScratchProject(environmentId, failureTitle);
    if (!project) return null;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) {
      onFailure();
      return null;
    }
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    return threadRef;
  };
}
