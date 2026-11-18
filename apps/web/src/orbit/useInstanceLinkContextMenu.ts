import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";
import type { MouseEvent } from "react";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { showExternalLinkContextMenu } from "~/components/chat/externalLinkContextMenu";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Conn: right-clicking an Instance address (ready line, Preview chip) shows the menu every chat
 * link shows (integrated browser, system browser, Copy Link) instead of the bare native menu.
 */
export function useInstanceLinkContextMenu(
  threadRef: ScopedThreadRef | null | undefined,
): (event: MouseEvent<HTMLElement>, url: string) => void {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return (event, url) => {
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    void showExternalLinkContextMenu({
      href: url,
      canOpenInPreview: canOpenLinksInApp(threadRef),
      position: { x: event.clientX, y: event.clientY },
      showContextMenu: (items, position) => api.contextMenu.show(items, position),
      openInPreview: async (target) => {
        if (!threadRef) return;
        const result = await openUrlInPreview({ threadRef, url: target, openPreview });
        if (result._tag === "Success") recordVisitForThread(threadRef, target);
        else if (!isAtomCommandInterrupted(result)) await api.shell.openExternal(target);
      },
      openExternal: (target) => api.shell.openExternal(target),
      copyLink: (target) =>
        writeTextToClipboard(target, {
          target: "link",
          unavailableMessage: msg("Clipboard API is unavailable while copying link."),
          failureMessage: msg("Failed to copy link to the clipboard."),
        }),
      reportFailure: (operation, cause) => console.error(operation, cause),
    });
  };
}
