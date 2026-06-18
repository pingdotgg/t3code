import type { LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { isPreviewableUrl } from "@t3tools/shared/preview";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly position: { x: number; y: number };
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly localApi: LocalApi;
  readonly fallbackToBrowser: () => void;
}

export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const supportsPreview =
    isPreviewableUrl(input.url) &&
    isPreviewSupportedInRuntime() &&
    input.threadRef.threadId.length > 0;

  if (!supportsPreview) {
    input.fallbackToBrowser();
    return;
  }

  let choice: "open-in-preview" | "open-in-browser" | null;
  try {
    choice = await input.localApi.contextMenu.show(
      [
        { id: "open-in-preview", label: "Open in preview" },
        { id: "open-in-browser", label: "Open in browser" },
      ],
      input.position,
    );
  } catch {
    input.fallbackToBrowser();
    return;
  }

  if (choice === "open-in-preview") {
    const result = await input.openPreview({
      environmentId: input.threadRef.environmentId,
      input: { threadId: input.threadRef.threadId, url: input.url },
    });
    if (result._tag === "Failure") {
      input.fallbackToBrowser();
      return;
    }
    applyPreviewServerSnapshot(input.threadRef, result.value);
    useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
    return;
  }

  if (choice === "open-in-browser") {
    input.fallbackToBrowser();
  }
}
