import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  acquireBrowserSurfaceBackgroundCapture,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
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
    if (isPreviewAutomationTabPresented(input.threadRef, input.tabId)) return;

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

export async function withPreviewAutomationBackgroundPresentation<A>(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  timeoutMs: number,
  use: (background: boolean) => Promise<A>,
): Promise<A> {
  const background = !(useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false);
  if (!background) return await use(false);

  const timeoutError = () =>
    new PreviewAutomationBackgroundPresentationTimeoutError({
      requestId,
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      tabId,
      timeoutMs,
    });
  const releaseCapture = acquireBrowserSurfaceBackgroundCapture(tabId);
  let timedOut = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      timedOut = true;
      reject(timeoutError());
    }, timeoutMs);
  });
  const operation = (async () => {
    await waitForPreviewAutomationBackgroundPresentation({
      threadRef,
      requestId,
      tabId,
      timeoutMs,
    });
    if (timedOut) throw timeoutError();
    const stillBackground = !(useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false);
    return await use(stillBackground);
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    releaseCapture();
  }
}
