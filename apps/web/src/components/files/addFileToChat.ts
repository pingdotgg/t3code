import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import type { ComposerHandleRef } from "~/composerHandleContext";
import { m } from "~/i18n/messages";

/**
 * Appends a file mention to the open chat composer, the "Add to chat" action
 * shared by the files tree menu, the file preview header and media previews.
 */
export function addFileMentionToChat(
  composerRef: ComposerHandleRef | null,
  relativePath: string,
): void {
  const composer = composerRef?.current;
  if (!composer) {
    toastManager.add({
      type: "error",
      title: m(msg("Unable to add to chat")),
      description: m(msg("Open a chat for this project and try again.")),
    });
    return;
  }
  const inserted = composer.insertTextAtEnd(`${serializeComposerFileLink(relativePath)} `, {
    ensureLeadingBoundary: true,
  });
  if (!inserted) {
    toastManager.add({
      type: "error",
      title: m(msg("Unable to add to chat")),
      description: m(msg("The chat isn't ready to accept input right now.")),
    });
  }
}
