import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function useThreadModelSelection() {
  const save = useAtomCommand(threadEnvironment.setModelSelection, {
    reportFailure: false,
  });
  return useCallback(
    async (thread: ScopedThreadRef, modelSelection: ModelSelection) => {
      const result = await save({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId, modelSelection },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not save model selection",
          description: "Reconnect and select a model again before sending.",
        });
      }
      return result;
    },
    [save],
  );
}
