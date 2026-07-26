import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  acquireBrowserSurfaceBackgroundCapture,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { setActivePreviewTab } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { PreviewAutomationBackgroundPresentationTimeoutError } from "./previewAutomationErrors";

interface PreviewAutomationBackgroundPresentationInput {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: string;
  readonly tabId: string;
  readonly timeoutMs: number;
}

function backgroundPresentationTimeoutError(
  input: PreviewAutomationBackgroundPresentationInput,
): PreviewAutomationBackgroundPresentationTimeoutError {
  return new PreviewAutomationBackgroundPresentationTimeoutError({
    requestId: input.requestId,
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    tabId: input.tabId,
    timeoutMs: input.timeoutMs,
  });
}

async function waitForPreviewAutomationCompositorFrame(
  deadline: number,
  timeoutError: () => PreviewAutomationBackgroundPresentationTimeoutError,
): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let animationFrameId: number | undefined;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      if (animationFrameId !== undefined) window.cancelAnimationFrame?.(animationFrameId);
      reject(timeoutError());
    }, remainingMs);
    animationFrameId = window.requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve();
    });
  });
}

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

export async function waitForPreviewAutomationBackgroundPresentation(
  input: PreviewAutomationBackgroundPresentationInput,
): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const timeoutError = () => backgroundPresentationTimeoutError(input);
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
      await waitForPreviewAutomationCompositorFrame(deadline, timeoutError);
      await waitForPreviewAutomationCompositorFrame(deadline, timeoutError);
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(16, remainingMs)));
  }

  throw timeoutError();
}

export async function withPreviewAutomationBackgroundPresentation<A>(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  timeoutMs: number,
  use: (background: boolean) => Promise<A>,
): Promise<A> {
  const background = !isPreviewAutomationTabPresented(threadRef, tabId);
  if (!background) return await use(false);

  const input = { threadRef, requestId, tabId, timeoutMs };
  const timeoutError = () => backgroundPresentationTimeoutError(input);
  const deadline = Date.now() + timeoutMs;
  const releaseCapture = acquireBrowserSurfaceBackgroundCapture(tabId);
  let captureStarted = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    await waitForPreviewAutomationBackgroundPresentation(input);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    const stillBackground = !isPreviewAutomationTabPresented(threadRef, tabId);
    const capture = use(stillBackground);
    captureStarted = true;
    const operation = capture.finally(releaseCapture);
    const captureDeadline = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => reject(timeoutError()), remainingMs);
    });
    return await Promise.race([operation, captureDeadline]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (!captureStarted) releaseCapture();
  }
}
