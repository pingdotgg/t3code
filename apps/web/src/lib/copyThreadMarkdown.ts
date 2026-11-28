import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { threadTranscriptMarkdown } from "@t3tools/shared/threadTranscript";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { namedClipboardTarget, writeAsyncTextToClipboard } from "../hooks/useCopyToClipboard";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

export async function copyThreadMarkdown(threadRef: ScopedThreadRef): Promise<void> {
  try {
    await writeAsyncTextToClipboard(async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        orchestrationEnvironment.threadTranscript,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return threadTranscriptMarkdown(result.value);
    }, namedClipboardTarget("Markdown"));
    toastManager.add(
      stackedThreadToast({ type: "success", title: m(msg("Thread copied as Markdown")) }),
    );
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({ type: "error", title: m(msg("Failed to copy thread as Markdown")) }),
    );
  }
}
