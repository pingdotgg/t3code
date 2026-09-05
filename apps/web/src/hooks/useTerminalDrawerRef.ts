import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  environmentTerminalPinKey,
  projectTerminalPinKey,
  resolveTerminalDrawer,
  type TerminalDrawerPinState,
} from "../lib/terminalDrawer";
import { useThreadShell } from "../state/entities";
import { selectPinnedTerminalThreadKey, useTerminalUiStateStore } from "../terminalUiStateStore";

export interface ThreadLocation {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

/**
 * Where a thread lives, from the shell index or, for a not-yet-sent draft, the
 * composer draft store. Null when the thread is unknown to both.
 */
export function useThreadLocation(threadRef: ScopedThreadRef | null): ThreadLocation | null {
  const shell = useThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  return useMemo(() => {
    const source = shell ?? draft;
    if (!threadRef || !source) {
      return null;
    }
    return {
      environmentId: threadRef.environmentId,
      projectId: source.projectId,
      worktreePath: source.worktreePath ?? null,
    };
  }, [draft, shell, threadRef]);
}

/** Project key the thread belongs to. Null when the thread is unknown. */
export function useThreadProjectKey(threadRef: ScopedThreadRef | null): string | null {
  const location = useThreadLocation(threadRef);
  return location
    ? scopedProjectKey(scopeProjectRef(location.environmentId, location.projectId))
    : null;
}

function usePinnedThreadRef(pinKey: string | null): ScopedThreadRef | null {
  const pinnedThreadKey = useTerminalUiStateStore((state) =>
    selectPinnedTerminalThreadKey(state.pinnedTerminalThreadKeyByPinKey, pinKey),
  );
  return useMemo(
    () => (pinnedThreadKey ? parseScopedThreadKey(pinnedThreadKey) : null),
    [pinnedThreadKey],
  );
}

/**
 * Drawer `terminal.toggle` targets for `threadRef`, and which pin put it
 * there. Pins to threads that no longer exist, or that moved to another
 * project, are ignored. Stable while the inputs are.
 */
export function useTerminalDrawerPin(threadRef: ScopedThreadRef | null): {
  drawerRef: ScopedThreadRef | null;
  pinState: TerminalDrawerPinState;
} {
  const projectKey = useThreadProjectKey(threadRef);
  const projectPinnedRef = usePinnedThreadRef(
    projectKey === null ? null : projectTerminalPinKey(projectKey),
  );
  const environmentPinnedRef = usePinnedThreadRef(
    threadRef === null ? null : environmentTerminalPinKey(threadRef.environmentId),
  );
  // A null project key means the pinned thread is gone.
  const projectPinnedProjectKey = useThreadProjectKey(projectPinnedRef);
  const environmentPinnedProjectKey = useThreadProjectKey(environmentPinnedRef);
  const projectPinValid =
    projectPinnedProjectKey !== null && projectPinnedProjectKey === projectKey;
  const environmentPinValid = environmentPinnedProjectKey !== null;
  return useMemo(
    () =>
      resolveTerminalDrawer({
        threadRef,
        projectPinnedThreadRef: projectPinValid ? projectPinnedRef : null,
        environmentPinnedThreadRef: environmentPinValid ? environmentPinnedRef : null,
      }),
    [environmentPinValid, environmentPinnedRef, projectPinValid, projectPinnedRef, threadRef],
  );
}

export function useTerminalDrawerRef(threadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  return useTerminalDrawerPin(threadRef).drawerRef;
}
