import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import {
  runBulkLaunchQueue,
  type BulkLaunchOutcome,
  type BulkLaunchProgress,
} from "~/lib/bulkLaunchQueue";
import { buildThreadLaunchInput, type ThreadLaunchSpec } from "~/lib/threadLaunch";
import { newMessageId, newThreadId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Starts a batch of threads one at a time. Each launch resolves only after the
 * server created the thread, prepared its worktree and dispatched the turn, so
 * the queue never has two worktree preparations running on one repository.
 */
export function useBulkThreadLaunch() {
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [progress, setProgress] = useState<BulkLaunchProgress | null>(null);
  const cancelledRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const launch = useCallback(
    async (input: {
      environmentId: EnvironmentId;
      specs: ReadonlyArray<ThreadLaunchSpec>;
    }): Promise<BulkLaunchOutcome<ThreadLaunchSpec>> => {
      cancelledRef.current = false;
      setProgress({ completed: 0, total: input.specs.length });
      try {
        return await runBulkLaunchQueue({
          items: input.specs,
          isCancelled: () => cancelledRef.current,
          onProgress: setProgress,
          launch: async (spec) => {
            const result = await startThreadTurn({
              environmentId: input.environmentId,
              input: buildThreadLaunchInput(spec, {
                threadId: newThreadId(),
                messageId: newMessageId(),
                createdAt: new Date().toISOString(),
              }),
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              throw error instanceof Error ? error : new Error("Failed to start thread.");
            }
          },
        });
      } finally {
        setProgress(null);
      }
    },
    [startThreadTurn],
  );

  return { launch, cancel, progress };
}
