import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { resolveRenameCommit } from "../components/chat/ChatHeader.logic";
import { toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/** Commits a new thread title with the header's validation and error toasts. */
export function useRenameThread(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly currentTitle: string;
}) {
  const { environmentId, threadId, currentTitle } = input;
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  return useCallback(
    (title: string) => {
      const resolution = resolveRenameCommit({ title, originalTitle: currentTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId,
        input: { threadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [currentTitle, environmentId, threadId, updateThreadMetadata],
  );
}
