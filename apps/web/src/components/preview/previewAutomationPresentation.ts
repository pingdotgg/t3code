import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  acquireBrowserSurfaceBackgroundCapture,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { setActivePreviewTab } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  PreviewAutomationBackgroundPresentationTimeoutError,
  PreviewAutomationVisibilityTimeoutError,
} from "./previewAutomationErrors";
import { assertPreviewRuntimeCurrent } from "./previewNavigationReadiness";

interface PreviewAutomationPresentationTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
}

interface PreviewAutomationBackgroundPresentationInput extends PreviewAutomationPresentationTarget {
  readonly requestId: string;
  readonly timeoutMs: number;
}

interface PreviewAutomationVisibilityInput extends PreviewAutomationPresentationTarget {
  readonly requestId: string;
  readonly timeoutMs: number;
}

interface PreviewAutomationBackgroundPresentationUseInput<
  A,
> extends PreviewAutomationBackgroundPresentationInput {
  readonly use: (background: boolean) => Promise<A>;
}

type PreviewAutomationPresentationDiagnostics = Required<
  Pick<
    PreviewAutomationVisibilityTimeoutError,
    | "activeSurfaceKind"
    | "activeSurfaceId"
    | "inlinePreviewOpen"
    | "inlinePreviewTabId"
    | "rightPanelOpen"
    | "rightPanelSurfaceId"
    | "surfaceRegistered"
    | "presentationRectAvailable"
  >
>;

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

function readPreviewAutomationPresentation(input: PreviewAutomationPresentationTarget) {
  const panel = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    input.threadRef,
  );
  const miniPlayer = selectThreadPreviewMiniPlayer(
    usePreviewMiniPlayerStore.getState().byThreadKey,
    input.threadRef,
  );
  const presentation = useBrowserSurfaceStore.getState().byTabId[input.runtimeTabId];
  return { panel, miniPlayer, presentation };
}

export function readPreviewAutomationPresentationDiagnostics(
  input: PreviewAutomationPresentationTarget,
): PreviewAutomationPresentationDiagnostics {
  const { panel, miniPlayer, presentation } = readPreviewAutomationPresentation(input);
  const activeSurfaceKind =
    miniPlayer !== null
      ? ("inline-preview" as const)
      : panel.isOpen && panel.activeSurfaceId !== null
        ? ("right-panel" as const)
        : ("none" as const);
  return {
    activeSurfaceKind,
    activeSurfaceId:
      miniPlayer !== null
        ? `mini-player:${miniPlayer.tabId}`
        : panel.isOpen
          ? panel.activeSurfaceId
          : null,
    inlinePreviewOpen: miniPlayer !== null,
    inlinePreviewTabId: miniPlayer?.tabId ?? null,
    rightPanelOpen: panel.isOpen,
    rightPanelSurfaceId: panel.activeSurfaceId,
    surfaceRegistered: presentation !== undefined,
    presentationRectAvailable: presentation?.rect != null,
  };
}

export function isPreviewAutomationTabPresented(
  input: PreviewAutomationPresentationTarget,
): boolean {
  const { panel, miniPlayer, presentation } = readPreviewAutomationPresentation(input);
  const requestedSurfaceIsActive =
    (panel.isOpen && panel.activeSurfaceId === `browser:${input.tabId}`) ||
    miniPlayer?.tabId === input.tabId;
  return requestedSurfaceIsActive && (presentation?.visible ?? false);
}

const PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS = 500;

export async function waitForPreviewPresentation(
  runtimeTabId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.min(PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS, timeoutMs);
  while (true) {
    if (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(16, remainingMs)));
  }
}

export async function waitForBrowserSurfaceVisibility(
  input: PreviewAutomationVisibilityInput,
): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const requiredStableMs = Math.min(100, Math.max(0, input.timeoutMs - 50));
  let presentedSince: number | null = null;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, {
      operation: "open",
      requestId: input.requestId,
    });
    const now = Date.now();
    if (isPreviewAutomationTabPresented(input)) {
      presentedSince ??= now;
      // Require the selection to survive multiple presentation updates. A
      // single transient `visible` frame can otherwise make open acknowledge
      // just before routing or panel reconciliation unmounts the surface.
      if (now - presentedSince >= requiredStableMs) return;
    } else {
      presentedSince = null;
      // Same-server reconciliation and route hydration can race a cold open.
      // Reassert the explicit show request only when no surface already
      // selects this tab. Reopening the mini-player would steal the shared
      // browser-surface lease from a panel that is still becoming visible.
      const { panel, miniPlayer } = readPreviewAutomationPresentation(input);
      const selectedInPanel = panel.isOpen && panel.activeSurfaceId === `browser:${input.tabId}`;
      if (!selectedInPanel && miniPlayer?.tabId !== input.tabId) {
        revealPreviewAutomationTab(input.threadRef, input.tabId);
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(50, remainingMs)));
  }
  throw new PreviewAutomationVisibilityTimeoutError({
    requestId: input.requestId,
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    tabId: input.tabId,
    timeoutMs: input.timeoutMs,
    ...readPreviewAutomationPresentationDiagnostics(input),
  });
}

export async function waitForPreviewAutomationBackgroundPresentation(
  input: PreviewAutomationBackgroundPresentationInput,
): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const timeoutError = () => backgroundPresentationTimeoutError(input);
  while (true) {
    assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, {
      operation: "snapshot",
      requestId: input.requestId,
    });
    if (isPreviewAutomationTabPresented(input)) {
      return;
    }

    const wrapper = Array.from(
      document.querySelectorAll<HTMLElement>("[data-preview-viewport]"),
    ).find(
      (candidate) =>
        candidate.dataset["previewViewport"] === input.runtimeTabId &&
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
      assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, {
        operation: "snapshot",
        requestId: input.requestId,
      });
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(16, remainingMs)));
  }

  throw timeoutError();
}

export async function withPreviewAutomationBackgroundPresentation<A>(
  input: PreviewAutomationBackgroundPresentationUseInput<A>,
): Promise<A> {
  assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, {
    operation: "snapshot",
    requestId: input.requestId,
  });
  const background = !isPreviewAutomationTabPresented(input);
  if (!background) return await input.use(false);

  const timeoutError = () => backgroundPresentationTimeoutError(input);
  const deadline = Date.now() + input.timeoutMs;
  const releaseCapture = acquireBrowserSurfaceBackgroundCapture(input.runtimeTabId);
  let captureStarted = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    await waitForPreviewAutomationBackgroundPresentation(input);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, {
      operation: "snapshot",
      requestId: input.requestId,
    });
    const stillBackground = !isPreviewAutomationTabPresented(input);
    const capture = input.use(stillBackground);
    captureStarted = true;
    // Keep the finalized capture in the race: Promise.race retains its rejection
    // handler after the deadline wins, so a delayed capture failure is observed
    // while this finalizer releases the presentation lease.
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
