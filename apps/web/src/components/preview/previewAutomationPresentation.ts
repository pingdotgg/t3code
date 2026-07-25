import type { ScopedThreadRef } from "@t3tools/contracts";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { setActivePreviewTab } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { PreviewAutomationBackgroundPresentationTimeoutError } from "./previewAutomationErrors";

export function revealPreviewAutomationTab(ref: ScopedThreadRef, tabId: string): void {
  setActivePreviewTab(ref, tabId);
  useRightPanelStore.getState().openBrowser(ref, tabId);
}

export function isPreviewAutomationTabPresented(ref: ScopedThreadRef, tabId: string): boolean {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  return (
    panel.isOpen &&
    panel.activeSurfaceId === `browser:${tabId}` &&
    (useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false)
  );
}

export async function waitForPreviewAutomationBackgroundPresentation(input: {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: string;
  readonly tabId: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const wrapper = Array.from(
      document.querySelectorAll<HTMLElement>("[data-preview-viewport]"),
    ).find(
      (candidate) =>
        candidate.dataset["previewViewport"] === input.tabId &&
        candidate.dataset["previewBackgroundCapture"] === "true",
    );
    if (wrapper) {
      // Force the staged wrapper through layout, then allow Chromium two
      // compositor frames before asking the guest WebContents for pixels.
      void wrapper.offsetWidth;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(16, remainingMs)));
  }

  throw new PreviewAutomationBackgroundPresentationTimeoutError({
    requestId: input.requestId,
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    tabId: input.tabId,
    timeoutMs: input.timeoutMs,
  });
}
