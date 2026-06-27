import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftId } from "../composerDraftStore";
import {
  clearThreadErrorRecord,
  retainThreadKeyRecord,
  shouldApplySourceControlMetadataUpdateResult,
} from "./ChatView.logic";

type UpdateThreadMetadata = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  };
}) => Promise<AtomCommandResult<unknown, unknown>>;

type SetDraftThreadContext = (
  target: DraftId | ScopedThreadRef,
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

function sourceControlMetadataErrorFromFailure(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Failed to update thread source control.";
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
  const metadataUpdateSequenceByThreadKeyRef = useRef<Record<string, number>>({});
  const [metadataErrorsByThreadKey, setMetadataErrorsByThreadKey] = useState<
    Record<string, string | null>
  >({});
  const sourceControlMetadataError =
    activeThreadKey === null ? null : (metadataErrorsByThreadKey[activeThreadKey] ?? null);

  useEffect(() => {
    setMetadataErrorsByThreadKey((existing) => retainThreadKeyRecord(existing, existingThreadKeys));
    for (const threadKey of Object.keys(metadataUpdateSequenceByThreadKeyRef.current)) {
      if (!existingThreadKeys.has(threadKey)) {
        delete metadataUpdateSequenceByThreadKeyRef.current[threadKey];
      }
    }
  }, [existingThreadKeys]);

  const clearActiveSourceControlMetadataError = useCallback(() => {
    if (!isServerThread || activeThreadKey === null) return;
    setMetadataErrorsByThreadKey((existing) => clearThreadErrorRecord(existing, activeThreadKey));
  }, [activeThreadKey, isServerThread]);

  const handleSourceControlThreadRefChange = useCallback(
    async (metadata: SourceControlThreadRefChange) => {
      if (!isServerThread) {
        const target = draftId ?? activeThreadRef;
        if (!target) return;
        setDraftThreadContext(target, {
          branch: metadata.branch,
          worktreePath: metadata.worktreePath,
        });
        return;
      }

      if (!activeThreadRef) return;
      const targetThreadKey = scopedThreadKey(activeThreadRef);
      const requestSequence =
        (metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey] ?? 0) + 1;
      metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey] = requestSequence;
      const result = await updateThreadMetadata({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadRef.threadId,
          branch: metadata.branch,
          worktreePath: metadata.worktreePath,
        },
      });
      if (
        !shouldApplySourceControlMetadataUpdateResult({
          currentSequence: metadataUpdateSequenceByThreadKeyRef.current[targetThreadKey],
          requestSequence,
        })
      ) {
        return;
      }
      if (result._tag === "Success") {
        setMetadataErrorsByThreadKey((existing) =>
          clearThreadErrorRecord(existing, targetThreadKey),
        );
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      setMetadataErrorsByThreadKey((existing) => ({
        ...existing,
        [targetThreadKey]: sourceControlMetadataErrorFromFailure(squashAtomCommandFailure(result)),
      }));
    },
    [activeThreadRef, draftId, isServerThread, setDraftThreadContext, updateThreadMetadata],
  );

  return {
    clearActiveSourceControlMetadataError,
    handleSourceControlThreadRefChange,
    sourceControlMetadataError,
  };
}
