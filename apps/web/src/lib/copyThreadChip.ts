import type { EnvironmentId, ThreadId } from "@lathe/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@lathe/shared/composerContextClipboard";
import { buildThreadChipClipboard } from "@lathe/shared/threadContextReference";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

/**
 * "Copy as thread chip" for the thread menus and the command palette: the link lands as
 * plain text and the record rides beside it, so pasting into a composer yields the chip.
 */
export async function copyThreadChip(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: { readonly id: ThreadId; readonly title: string };
}): Promise<void> {
  try {
    const { text, fragment } = buildThreadChipClipboard({
      thread: { ...input.thread, environmentId: input.environmentId },
    });
    const encoded = encodeComposerContextFragment(fragment);
    const didCopy = await writeTextToClipboard(
      text,
      undefined,
      encoded === null ? undefined : { [COMPOSER_CONTEXT_CLIPBOARD_MIME]: encoded },
    );
    if (!didCopy) return;
    toastManager.add({
      type: "success",
      title: "Thread chip copied",
      description: input.thread.title,
    });
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to copy thread chip",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
