import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

type ForkableThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;

// All fork entry points share this lock. A hook-local ref would allow the
// sidebar and message timeline to fork the same source concurrently.
const inFlightForkThreadKeys = new Set<string>();

export function useForkThread(): (
  sourceThread: ForkableThread,
  sourceTurnId: TurnId,
) => Promise<ScopedThreadRef | null> {
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });

  return useCallback(
    async (sourceThread: ForkableThread, sourceTurnId: TurnId): Promise<ScopedThreadRef | null> => {
      const sourceThreadKey = `${sourceThread.environmentId}:${sourceThread.id}`;
      if (inFlightForkThreadKeys.has(sourceThreadKey)) {
        return null;
      }

      inFlightForkThreadKeys.add(sourceThreadKey);
      const nextThreadId = newThreadId();
      try {
        const result = await forkThread({
          environmentId: sourceThread.environmentId,
          input: {
            threadId: nextThreadId,
            sourceThreadId: sourceThread.id,
            sourceTurnId,
            title: truncate(`${sourceThread.title} (fork)`),
            createdAt: new Date().toISOString(),
          },
        });

        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not fork thread",
                description:
                  error instanceof Error ? error.message : "The thread could not be forked.",
              }),
            );
          }
          return null;
        }

        return scopeThreadRef(sourceThread.environmentId, nextThreadId);
      } finally {
        inFlightForkThreadKeys.delete(sourceThreadKey);
      }
    },
    [forkThread],
  );
}
