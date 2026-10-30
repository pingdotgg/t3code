import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { newMessageId } from "~/lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

function reportFailure(description: string) {
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Could not send feedback", description }),
  );
}

/** Posts a message to a run's coordinator chat; failures show as a toast and resolve to false. */
export function usePipelineCoordinatorSend(environmentId: EnvironmentId, parentThreadId: ThreadId) {
  const coordinator = useQuietThreadShell(scopeThreadRef(environmentId, parentThreadId));
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return async (text: string): Promise<boolean> => {
    if (coordinator === null) {
      reportFailure("The coordinator chat is not available.");
      return false;
    }
    const result = await startTurn({
      environmentId,
      input: {
        threadId: parentThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: coordinator.runtimeMode,
        interactionMode: coordinator.interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      reportFailure(error instanceof Error ? error.message : String(error));
    }
    return false;
  };
}
