import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

type ForkableThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;

export function useForkThread(): (
  sourceThread: ForkableThread,
  sourceTurnId: TurnId,
) => Promise<ScopedThreadRef | null> {
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const inFlightThreadKeysRef = useRef(new Set<string>());

  return useCallback(
    async (sourceThread: ForkableThread, sourceTurnId: TurnId): Promise<ScopedThreadRef | null> => {
      const sourceThreadKey = `${sourceThread.environmentId}:${sourceThread.id}`;
      if (inFlightThreadKeysRef.current.has(sourceThreadKey)) {
        return null;
      }

      inFlightThreadKeysRef.current.add(sourceThreadKey);
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
        inFlightThreadKeysRef.current.delete(sourceThreadKey);
      }
    },
    [forkThread],
  );
}
