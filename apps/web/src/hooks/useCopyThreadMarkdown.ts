import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { threadTranscriptMarkdown } from "@t3tools/shared/threadTranscript";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useStableCallback } from "./useStableCallback";

function copyFailureToast(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Failed to copy thread as Markdown",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useCopyThreadMarkdown() {
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  return useStableCallback(async (threadRef: ScopedThreadRef) => {
    const result = await loadThreadTranscript({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) copyFailureToast(squashAtomCommandFailure(result));
      return;
    }
    try {
      const didCopy = await writeTextToClipboard(
        threadTranscriptMarkdown(result.value),
        "thread as Markdown",
      );
      if (!didCopy) return;
      toastManager.add({
        type: "success",
        title: "Thread copied as Markdown",
        description: result.value.title,
      });
    } catch (error) {
      copyFailureToast(error);
    }
  });
}
