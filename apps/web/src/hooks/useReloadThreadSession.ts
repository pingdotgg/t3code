import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadSessionReloadAvailability } from "@t3tools/client-runtime/state/thread-session";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

export function useReloadThreadSession() {
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const availability = threadSessionReloadAvailability(
        readThreadShell(threadRef)?.session?.status ?? null,
      );
      if (availability === "disabled") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reload agent session",
            description: "Wait for the active turn to finish before reloading the session.",
          }),
        );
        return;
      }
      if (availability === "hidden") return;

      const result = await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not reload agent session",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Agent session will reload",
          description:
            "Your next message will resume this thread with current provider and MCP settings.",
        }),
      );
    },
    [stopThreadSession],
  );
}
