import type { UpdateThreadMetadataInput } from "@t3tools/client-runtime/operations";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerThreadTarget, DraftId } from "../composerDraftStore";
import {
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  clearThreadErrorRecord,
  retainThreadKeyRecord,
  shouldApplySourceControlMetadataUpdateResult,
} from "./ChatView.logic";

type UpdateThreadMetadata = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: UpdateThreadMetadataInput;
}) => Promise<AtomCommandResult<unknown, unknown>>;

type SetDraftThreadContext = (
  target: ComposerThreadTarget,
  context: {
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
  },
) => void;

interface SourceControlThreadRefChange {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

interface UseSourceControlThreadMetadataRoutingInput {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly draftId: DraftId | null;
  readonly expectedBranch: string | null;
  readonly hasExpectedBranchObservation: boolean;
  readonly existingThreadKeys: ReadonlySet<string>;
  readonly isServerThread: boolean;
  readonly setDraftThreadContext: SetDraftThreadContext;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

interface SourceControlThreadMetadataRouting {
  readonly sourceControlMetadataError: string | null;
  readonly clearActiveSourceControlMetadataError: () => void;
  readonly handleSourceControlThreadRefChange: (
    input: SourceControlThreadRefChange,
  ) => Promise<void>;
}

interface UseSourceControlRightPanelSurfaceInput {
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly rightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlRightPanelSurfaceState {
  readonly addSourceControlSurface: () => void;
  readonly sourceControlAvailable: boolean;
  readonly visibleActiveRightPanelSurface: RightPanelSurface | null;
  readonly visibleRightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlPanelTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ScopedThreadRef["threadId"];
  readonly cwd: string;
}

interface SourceControlServerMetadataUpdateInput {
  readonly activeThreadRef: ScopedThreadRef;
  readonly expectedBranch: string | null;
  readonly metadata: SourceControlThreadRefChange;
  readonly requestSequence: number;
  readonly getCurrentSequence: () => number | undefined;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

interface QueuedSourceControlServerMetadataUpdateInput {
  readonly activeThreadRef: ScopedThreadRef;
  readonly expectedBranch: string | null;
  readonly metadata: SourceControlThreadRefChange;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

type SourceControlServerMetadataUpdateResult =
  | {
      readonly _tag: "Success";
    }
  | {
      readonly _tag: "Stale";
    }
  | {
      readonly _tag: "Interrupted";
    }
  | {
      readonly _tag: "Failure";
      readonly message: string;
    };

export type ThreadErrorSource = "draft" | "local-server" | "source-control" | "session";

export function resolveThreadErrorDismissAction(
  source: ThreadErrorSource | null,
): "clear-thread" | "clear-source-control" | "mask-only" {
  if (source === "draft" || source === "local-server") return "clear-thread";
  if (source === "source-control") return "clear-source-control";
  return "mask-only";
}

export function resolveThreadErrorPresentation(input: {
  readonly isServerThread: boolean;
  readonly localDraftError: string | null;
  readonly localServerError: string | null;
  readonly sessionError: string | null;
  readonly sourceControlMetadataError: string | null;
}): { readonly error: string | null; readonly source: ThreadErrorSource | null } {
  if (!input.isServerThread) {
    return input.localDraftError === null
      ? { error: null, source: null }
      : { error: input.localDraftError, source: "draft" };
  }
  if (input.localServerError !== null) {
    return { error: input.localServerError, source: "local-server" };
  }
  if (input.sourceControlMetadataError !== null) {
    return { error: input.sourceControlMetadataError, source: "source-control" };
  }
  return input.sessionError === null
    ? { error: null, source: null }
    : { error: input.sessionError, source: "session" };
}

export function sourceControlMetadataErrorFromFailure(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = "message" in error ? error.message : null;
    const code = "code" in error ? error.code : null;
    if (typeof message === "string" && message.length > 0) {
      return typeof code === "string" && code.length > 0 ? `${message} (${code})` : message;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      return "Failed to update thread source control.";
    }
  }
  return "Failed to update thread source control.";
}

export function resolveSourceControlDraftMetadataTarget(input: {
  readonly draftId: DraftId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
}): ComposerThreadTarget | null {
  return input.draftId ?? input.activeThreadRef;
}

export function isSourceControlAvailable(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
}): boolean {
  return input.activeThreadRef !== null && input.gitCwd !== null && input.isGitRepo;
}

export function filterVisibleSourceControlSurfaces(input: {
  readonly surfaces: readonly RightPanelSurface[];
  readonly sourceControlAvailable: boolean;
}): readonly RightPanelSurface[] {
  return input.sourceControlAvailable
    ? input.surfaces
    : input.surfaces.filter((surface) => surface.kind !== "source-control");
}

export function resolveVisibleSourceControlSurface(input: {
  readonly surface: RightPanelSurface | null;
  readonly sourceControlAvailable: boolean;
  readonly visibleSurfaces: readonly RightPanelSurface[];
}): RightPanelSurface | null {
  return input.surface?.kind === "source-control" && !input.sourceControlAvailable
    ? (input.visibleSurfaces[0] ?? null)
    : input.surface;
}

export function resolveSourceControlPanelTarget(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly surface: RightPanelSurface | null;
}): SourceControlPanelTarget | null {
  if (input.surface?.kind !== "source-control" || !input.activeThreadRef || !input.gitCwd) {
    return null;
  }
  return {
    environmentId: input.activeThreadRef.environmentId,
    threadId: input.activeThreadRef.threadId,
    cwd: input.gitCwd,
  };
}

export function selectSourceControlMetadataError(
  metadataErrorsByThreadKey: Readonly<Record<string, string | null>>,
  activeThreadKey: string | null,
): string | null {
  return activeThreadKey === null ? null : (metadataErrorsByThreadKey[activeThreadKey] ?? null);
}

export function retargetOpenSourceControlSurface(input: {
  readonly currentThreadRef: ScopedThreadRef;
  readonly nextThreadRef: ScopedThreadRef;
}): void {
  if (scopedThreadKey(input.currentThreadRef) === scopedThreadKey(input.nextThreadRef)) return;
  const store = useRightPanelStore.getState();
  const activeSurface = selectActiveRightPanelSurface(store.byThreadKey, input.currentThreadRef);
  if (activeSurface?.kind !== "source-control") return;
  store.open(input.nextThreadRef, "source-control");
}

export async function runSourceControlServerMetadataUpdate(
  input: SourceControlServerMetadataUpdateInput,
): Promise<SourceControlServerMetadataUpdateResult> {
  const {
    activeThreadRef,
    expectedBranch,
    getCurrentSequence,
    metadata,
    requestSequence,
    updateThreadMetadata,
  } = input;
  let result: AtomCommandResult<unknown, unknown>;
  try {
    result = await updateThreadMetadata({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadRef.threadId,
        branch: metadata.branch,
        expectedBranch,
        worktreePath: metadata.worktreePath,
      },
    });
  } catch (error) {
    if (
      !shouldApplySourceControlMetadataUpdateResult({
        currentSequence: getCurrentSequence(),
        requestSequence,
      })
    ) {
      return { _tag: "Stale" };
    }
    return {
      _tag: "Failure",
      message: sourceControlMetadataErrorFromFailure(error),
    };
  }

  if (
    !shouldApplySourceControlMetadataUpdateResult({
      currentSequence: getCurrentSequence(),
      requestSequence,
    })
  ) {
    return { _tag: "Stale" };
  }
  if (result._tag === "Success") {
    return { _tag: "Success" };
  }
  if (isAtomCommandInterrupted(result)) {
    return { _tag: "Interrupted" };
  }
  return {
    _tag: "Failure",
    message: sourceControlMetadataErrorFromFailure(squashAtomCommandFailure(result)),
  };
}

export function createSourceControlServerMetadataUpdateQueue() {
  const expectedBranchByThreadKey = new Map<
    string,
    {
      branch: string | null;
      observationSequence: number;
      latestObservedBranch: string | null;
      latestObservationIsStale: boolean;
      pendingTransition: {
        staleBranches: ReadonlySet<string | null>;
        to: string | null;
      } | null;
    }
  >();
  const pendingByThreadKey = new Map<string, Promise<void>>();
  const sequenceByThreadKey = new Map<string, number>();

  const observe = (activeThreadRef: ScopedThreadRef, expectedBranch: string | null) => {
    const targetThreadKey = scopedThreadKey(activeThreadRef);
    const expected = expectedBranchByThreadKey.get(targetThreadKey);
    if (!expected) {
      expectedBranchByThreadKey.set(targetThreadKey, {
        branch: expectedBranch,
        latestObservedBranch: expectedBranch,
        latestObservationIsStale: false,
        observationSequence: 1,
        pendingTransition: null,
      });
      return;
    }
    expected.latestObservedBranch = expectedBranch;
    expected.latestObservationIsStale = false;
    expected.observationSequence += 1;
    const transition = expected.pendingTransition;
    if (transition && expectedBranch === transition.to) {
      expected.branch = expectedBranch;
      expected.pendingTransition = null;
      return;
    }
    if (transition?.staleBranches.has(expectedBranch)) {
      expected.latestObservationIsStale = true;
      return;
    }
    expected.branch = expectedBranch;
    expected.pendingTransition = null;
  };

  return {
    observe,
    enqueue(input: QueuedSourceControlServerMetadataUpdateInput) {
      const targetThreadKey = scopedThreadKey(input.activeThreadRef);
      const previous = pendingByThreadKey.get(targetThreadKey);
      if (!expectedBranchByThreadKey.has(targetThreadKey)) {
        expectedBranchByThreadKey.set(targetThreadKey, {
          branch: input.expectedBranch,
          latestObservedBranch: input.expectedBranch,
          latestObservationIsStale: false,
          observationSequence: 0,
          pendingTransition: null,
        });
      }

      const result = (previous ?? Promise.resolve()).then(async () => {
        const expectedBranchState = expectedBranchByThreadKey.get(targetThreadKey);
        const requestExpectedBranch = expectedBranchState?.branch ?? null;
        const observationSequence = expectedBranchState?.observationSequence ?? 0;
        const requestSequence = (sequenceByThreadKey.get(targetThreadKey) ?? 0) + 1;
        sequenceByThreadKey.set(targetThreadKey, requestSequence);
        const updateResult = await runSourceControlServerMetadataUpdate({
          activeThreadRef: input.activeThreadRef,
          expectedBranch: requestExpectedBranch,
          getCurrentSequence: () => sequenceByThreadKey.get(targetThreadKey),
          metadata: input.metadata,
          requestSequence,
          updateThreadMetadata: input.updateThreadMetadata,
        });
        if (updateResult._tag === "Success") {
          const latestExpectedBranchState = expectedBranchByThreadKey.get(targetThreadKey);
          if (!latestExpectedBranchState) return updateResult;
          const observedDuringRequest =
            latestExpectedBranchState.observationSequence !== observationSequence;
          if (
            !observedDuringRequest ||
            latestExpectedBranchState.latestObservationIsStale ||
            latestExpectedBranchState.latestObservedBranch === requestExpectedBranch
          ) {
            const staleBranches = new Set(
              latestExpectedBranchState.pendingTransition?.staleBranches ?? [],
            );
            staleBranches.add(requestExpectedBranch);
            latestExpectedBranchState.branch = input.metadata.branch;
            latestExpectedBranchState.pendingTransition = {
              staleBranches,
              to: input.metadata.branch,
            };
          } else if (latestExpectedBranchState.latestObservedBranch === input.metadata.branch) {
            latestExpectedBranchState.branch = input.metadata.branch;
            latestExpectedBranchState.pendingTransition = null;
          }
        }
        return updateResult;
      });
      const pending = result.then(
        () => undefined,
        () => undefined,
      );
      pendingByThreadKey.set(targetThreadKey, pending);
      void pending.finally(() => {
        if (pendingByThreadKey.get(targetThreadKey) === pending) {
          pendingByThreadKey.delete(targetThreadKey);
        }
      });
      return result;
    },
  };
}

export function useSourceControlRightPanelSurfaceState(
  input: UseSourceControlRightPanelSurfaceInput,
): SourceControlRightPanelSurfaceState {
  const { activeRightPanelSurface, activeThreadRef, gitCwd, isGitRepo, rightPanelSurfaces } = input;
  const sourceControlAvailable = isSourceControlAvailable({
    activeThreadRef,
    gitCwd,
    isGitRepo,
  });
  const visibleRightPanelSurfaces = useMemo(
    () =>
      filterVisibleSourceControlSurfaces({
        sourceControlAvailable,
        surfaces: rightPanelSurfaces,
      }),
    [rightPanelSurfaces, sourceControlAvailable],
  );
  const visibleActiveRightPanelSurface = resolveVisibleSourceControlSurface({
    sourceControlAvailable,
    surface: activeRightPanelSurface,
    visibleSurfaces: visibleRightPanelSurfaces,
  });
  const addSourceControlSurface = useCallback(() => {
    if (!activeThreadRef || !sourceControlAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "source-control");
  }, [activeThreadRef, sourceControlAvailable]);

  return {
    addSourceControlSurface,
    sourceControlAvailable,
    visibleActiveRightPanelSurface,
    visibleRightPanelSurfaces,
  };
}

export function useSourceControlThreadMetadataRouting(
  input: UseSourceControlThreadMetadataRoutingInput,
): SourceControlThreadMetadataRouting {
  const {
    activeThreadKey,
    activeThreadRef,
    draftId,
    expectedBranch,
    hasExpectedBranchObservation,
    existingThreadKeys,
    isServerThread,
    setDraftThreadContext,
    updateThreadMetadata,
  } = input;
  const metadataUpdateQueueRef = useRef<ReturnType<
    typeof createSourceControlServerMetadataUpdateQueue
  > | null>(null);
  const metadataUpdateQueue =
    metadataUpdateQueueRef.current ?? createSourceControlServerMetadataUpdateQueue();
  metadataUpdateQueueRef.current = metadataUpdateQueue;
  const [metadataErrorsByThreadKey, setMetadataErrorsByThreadKey] = useState<
    Record<string, string | null>
  >({});
  const sourceControlMetadataError = selectSourceControlMetadataError(
    metadataErrorsByThreadKey,
    activeThreadKey,
  );
  const activeThreadEnvironmentId = activeThreadRef?.environmentId ?? null;
  const activeThreadId = activeThreadRef?.threadId ?? null;
  const activeThreadMetadataRef = useMemo<ScopedThreadRef | null>(() => {
    if (activeThreadEnvironmentId === null || activeThreadId === null) return null;
    return {
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
    };
  }, [activeThreadEnvironmentId, activeThreadId]);

  useEffect(() => {
    setMetadataErrorsByThreadKey((existing) => retainThreadKeyRecord(existing, existingThreadKeys));
  }, [existingThreadKeys]);

  useEffect(() => {
    if (!activeThreadMetadataRef || !hasExpectedBranchObservation) return;
    metadataUpdateQueue.observe(activeThreadMetadataRef, expectedBranch);
  }, [activeThreadMetadataRef, expectedBranch, hasExpectedBranchObservation, metadataUpdateQueue]);

  const clearActiveSourceControlMetadataError = useCallback(() => {
    // Draft metadata changes are local store updates and do not create dismissible metadata errors.
    if (!isServerThread || activeThreadKey === null) return;
    setMetadataErrorsByThreadKey((existing) => clearThreadErrorRecord(existing, activeThreadKey));
  }, [activeThreadKey, isServerThread]);

  const handleSourceControlThreadRefChange = useCallback(
    async (metadata: SourceControlThreadRefChange) => {
      if (!isServerThread) {
        const target = resolveSourceControlDraftMetadataTarget({
          activeThreadRef: activeThreadMetadataRef,
          draftId,
        });
        if (!target) return;
        setDraftThreadContext(target, {
          branch: metadata.branch,
          worktreePath: metadata.worktreePath,
        });
        return;
      }

      if (!activeThreadMetadataRef) return;
      const targetThreadKey = scopedThreadKey(activeThreadMetadataRef);
      const result = await metadataUpdateQueue.enqueue({
        activeThreadRef: activeThreadMetadataRef,
        expectedBranch,
        metadata,
        updateThreadMetadata,
      });
      if (result._tag === "Success") {
        setMetadataErrorsByThreadKey((existing) =>
          clearThreadErrorRecord(existing, targetThreadKey),
        );
        return;
      }
      if (result._tag === "Stale" || result._tag === "Interrupted") return;
      setMetadataErrorsByThreadKey((existing) => ({
        ...existing,
        [targetThreadKey]: result.message,
      }));
    },
    [
      activeThreadMetadataRef,
      draftId,
      expectedBranch,
      isServerThread,
      metadataUpdateQueue,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  return {
    clearActiveSourceControlMetadataError,
    handleSourceControlThreadRefChange,
    sourceControlMetadataError,
  };
}
