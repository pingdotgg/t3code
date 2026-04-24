import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  PreviewSessionStreamEvent,
  ThreadId,
} from "@forma/contracts";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";

interface UsePreviewSessionInput {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
}

interface UsePreviewSessionResult {
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly openError: string | null;
  readonly restart: () => Promise<void>;
}

export function usePreviewSession(input: UsePreviewSessionInput): UsePreviewSessionResult {
  const [snapshot, setSnapshot] = useState<PreviewSessionSnapshot | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const handleSessionEvent = useEffectEvent((event: PreviewSessionStreamEvent) => {
    setSnapshot(event.snapshot);
  });

  useEffect(() => {
    if (!input.open || !input.cwd) {
      setSnapshot(null);
      setOpenError(null);
      return;
    }

    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      setSnapshot(null);
      setOpenError("Environment API is unavailable.");
      return;
    }

    const openInput: PreviewOpenInput = {
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.worktreePath !== null ? { worktreePath: input.worktreePath } : {}),
    };

    let disposed = false;
    const unsubscribe = api.preview.subscribe(
      { threadId: input.threadId },
      (event) => {
        if (!disposed) {
          handleSessionEvent(event);
        }
      },
      {
        onResubscribe: () => {
          if (disposed) {
            return;
          }
          setOpenError(null);
        },
      },
    );

    void api.preview
      .open(openInput)
      .then((nextSnapshot) => {
        if (disposed) {
          return;
        }
        setSnapshot(nextSnapshot);
        setOpenError(null);
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setOpenError(error instanceof Error ? error.message : "Failed to open preview session.");
      });

    return () => {
      disposed = true;
      unsubscribe();
      void api.preview.close({ threadId: input.threadId }).catch(() => undefined);
    };
  }, [input.cwd, input.environmentId, input.open, input.threadId, input.worktreePath]);

  const restart = useCallback(async () => {
    if (!input.cwd) {
      return;
    }
    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      setOpenError("Environment API is unavailable.");
      return;
    }

    const nextSnapshot = await api.preview.restart({
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.worktreePath !== null ? { worktreePath: input.worktreePath } : {}),
    });
    setSnapshot(nextSnapshot);
    setOpenError(null);
  }, [input.cwd, input.environmentId, input.threadId, input.worktreePath]);

  return {
    snapshot,
    openError,
    restart,
  };
}
