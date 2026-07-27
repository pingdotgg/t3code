import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  acquireBrowserSurfaceBackgroundCapture,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { setActivePreviewTab } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { PreviewAutomationBackgroundPresentationTimeoutError } from "./previewAutomationErrors";

interface PreviewAutomationBackgroundPresentationInput {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: string;
  readonly tabId: string;
  readonly timeoutMs: number;
}

const PREVIEW_AUTOMATION_COMPOSITOR_FRAME_FALLBACK_MS = 16;

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

  await new Promise<void>((resolve) => {
    let settled = false;
    let animationFrameId: number | undefined;
    const complete = () => {
      if (settled) return;
      settled = true;
      if (animationFrameId !== undefined) window.cancelAnimationFrame?.(animationFrameId);
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(
      () => {
        complete();
      },
      Math.min(PREVIEW_AUTOMATION_COMPOSITOR_FRAME_FALLBACK_MS, remainingMs),
    );
    animationFrameId = window.requestAnimationFrame(complete);
  });
}

export function revealPreviewAutomationTab(ref: ScopedThreadRef, tabId: string): void {
  setActivePreviewTab(ref, tabId);
  usePreviewMiniPlayerStore.getState().open(ref, tabId);
}

export function readPreviewAutomationPresentationDiagnostics(ref: ScopedThreadRef, tabId: string) {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  const miniPlayer = selectThreadPreviewMiniPlayer(
    usePreviewMiniPlayerStore.getState().byThreadKey,
    ref,
  );
  const presentation = useBrowserSurfaceStore.getState().byTabId[tabId];
  const activeSurfaceKind =
    miniPlayer !== null
      ? ("inline-preview" as const)
      : panel.isOpen && panel.activeSurfaceId !== null
        ? ("right-panel" as const)
        : ("none" as const);
  return {
    activeSurfaceKind,
    activeSurfaceId: miniPlayer?.tabId ?? panel.activeSurfaceId,
    inlinePreviewOpen: miniPlayer !== null,
    inlinePreviewTabId: miniPlayer?.tabId ?? null,
    rightPanelOpen: panel.isOpen,
    rightPanelSurfaceId: panel.activeSurfaceId,
    surfaceRegistered: presentation !== undefined,
    presentationRectAvailable: presentation?.rect !== null && presentation?.rect !== undefined,
  };
}

export function isPreviewAutomationTabPresented(ref: ScopedThreadRef, tabId: string): boolean {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  const miniPlayer = selectThreadPreviewMiniPlayer(
    usePreviewMiniPlayerStore.getState().byThreadKey,
    ref,
  );
  const requestedSurfaceIsActive =
    (panel.isOpen && panel.activeSurfaceId === `browser:${tabId}`) || miniPlayer?.tabId === tabId;
  return (
    requestedSurfaceIsActive && (useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false)
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
      // Electron can pause the host renderer's animation frames after placing
      // a native guest over it, so each wait falls back to one frame interval.
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
