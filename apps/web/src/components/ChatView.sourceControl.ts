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
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
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
  readonly rightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlRightPanelSurfaceState {
  readonly addSourceControlSurface: () => void;
  readonly sourceControlAvailable: boolean;
  readonly visibleActiveRightPanelSurface: RightPanelSurface | null;
  readonly visibleRightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlServerMetadataUpdateInput {
  readonly activeThreadRef: ScopedThreadRef;
  readonly metadata: SourceControlThreadRefChange;
  readonly requestSequence: number;
  readonly getCurrentSequence: () => number | undefined;
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
}): boolean {
  return input.activeThreadRef !== null && input.gitCwd !== null;
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
}): RightPanelSurface | null {
  return input.surface?.kind === "source-control" && !input.sourceControlAvailable
    ? null
    : input.surface;
}

export async function runSourceControlServerMetadataUpdate(
  input: SourceControlServerMetadataUpdateInput,
): Promise<SourceControlServerMetadataUpdateResult> {
  const { activeThreadRef, getCurrentSequence, metadata, requestSequence, updateThreadMetadata } =
    input;
  let result: AtomCommandResult<unknown, unknown>;
  try {
    result = await updateThreadMetadata({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadRef.threadId,
        branch: metadata.branch,
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

export function useSourceControlRightPanelSurfaceState(
  input: UseSourceControlRightPanelSurfaceInput,
): SourceControlRightPanelSurfaceState {
  const { activeRightPanelSurface, activeThreadRef, gitCwd, rightPanelSurfaces } = input;
  const sourceControlAvailable = isSourceControlAvailable({ activeThreadRef, gitCwd });
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
    existingThreadKeys,
    isServerThread,
    setDraftThreadContext,
    updateThreadMetadata,
  } = input;
  // Keep sequence values for the hook lifetime so a reopened thread key cannot reuse the
  // request number of an older update that is still resolving.
  const metadataUpdateSequenceByThreadKeyRef = useRef<Record<string, number>>({});
  const [metadataErrorsByThreadKey, setMetadataErrorsByThreadKey] = useState<
    Record<string, string | null>
  >({});
  const sourceControlMetadataError =
    activeThreadKey === null ? null : (metadataErrorsByThreadKey[activeThreadKey] ?? null);
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
      // This counter intentionally stays monotonic per live thread key: reusing values while an
      // older async update is still pending would let stale results match the latest request.
      const requestSequence =
        (metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey] ?? 0) + 1;
      metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey] = requestSequence;
      const result = await runSourceControlServerMetadataUpdate({
        activeThreadRef: activeThreadMetadataRef,
        getCurrentSequence: () => metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey],
        metadata,
        requestSequence,
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
    [activeThreadMetadataRef, draftId, isServerThread, setDraftThreadContext, updateThreadMetadata],
  );

  return {
    clearActiveSourceControlMetadataError,
    handleSourceControlThreadRefChange,
    sourceControlMetadataError,
  };
}
