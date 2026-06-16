import type { EnvironmentApi, LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { isPreviewableUrl } from "@t3tools/shared/preview";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

interface OpenTerminalLinkInPreviewInput {
  readonly url: string;
  readonly position: { x: number; y: number };
  readonly threadRef: ScopedThreadRef;
  readonly api: EnvironmentApi;
  readonly localApi: LocalApi;
  /** Called whenever the URL ultimately needs to open in the system browser. */
  readonly fallbackToBrowser: () => void;
}

/**
 * Handles a terminal-link click that resolves to a URL.
 *
 * - For non-loopback / unsupported runtimes, defers to the system browser.
 * - For previewable URLs in the desktop build, presents a context menu to
 *   choose between the in-app preview and the system browser.
 *
 * Failures fall back to the system browser so a stuck context-menu doesn't
 * leave the user without a way to open the link.
 */
export async function openTerminalLinkInPreview(
  input: OpenTerminalLinkInPreviewInput,
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
    try {
      await input.api.preview.open({
        threadId: input.threadRef.threadId,
        url: input.url,
      });
      useRightPanelStore.getState().open(input.threadRef, "preview");
    } catch {
      input.fallbackToBrowser();
    }
    return;
  }

  if (choice === "open-in-browser") {
    input.fallbackToBrowser();
  }
}
