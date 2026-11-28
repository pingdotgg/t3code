import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { threadTranscriptMarkdown } from "@t3tools/shared/threadTranscript";
import { msg } from "gt-react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../state/atom-registry";
import { orchestrationEnvironment } from "../state/orchestration";
import { tryCopyTextWithHaptic } from "./copyTextWithHaptic";

export async function copyThreadMarkdown(threadRef: ScopedThreadRef): Promise<void> {
  try {
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
    if (
      !(await tryCopyTextWithHaptic(threadTranscriptMarkdown(result.value), {
        target: "thread Markdown",
      }))
    ) {
      Dialog.alert(m(msg("Failed to copy thread as Markdown")), m(msg("Try again.")));
    }
  } catch (error) {
    console.error(error);
    Dialog.alert(m(msg("Failed to copy thread as Markdown")), m(msg("Try again.")));
  }
}
