import type { PreviewAutomationHostRendering } from "@t3tools/contracts";

/**
 * How long one animation frame may take before the host counts as paused.
 * Chromium stops delivering frames when the display is off or the window is
 * hidden; a painting window answers within a frame or two.
 */
export const PREVIEW_HOST_RENDERING_PROBE_MS = 500;

/**
 * Probes whether the host window is painting. There is no continuous timer:
 * one animation frame is requested only while a status or snapshot request
 * needs the answer, and the losing side of the race is cancelled. Hidden
 * documents report paused immediately, without waiting on a throttled timer.
 */
export const measurePreviewHostRendering = (
  boundMs = PREVIEW_HOST_RENDERING_PROBE_MS,
): Promise<PreviewAutomationHostRendering> =>
  new Promise((resolve) => {
    if (globalThis.document?.visibilityState === "hidden") {
      resolve("paused");
      return;
    }
    let frameId: number | null = null;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    frameId = globalThis.requestAnimationFrame(() => {
      frameId = null;
      if (timer !== null) globalThis.clearTimeout(timer);
      resolve("active");
    });
    timer = globalThis.setTimeout(() => {
      timer = null;
      if (frameId !== null) globalThis.cancelAnimationFrame(frameId);
      resolve("paused");
    }, boundMs);
  });

/**
 * Only requests with room for the probe measure liveness, so the 500 ms
 * favicon status lookup behind every action stays cheap. A host without
 * animation frames at all (non-browser test environments) reports nothing.
 */
export const canProbePreviewHostRendering = (remainingBudgetMs: number): boolean =>
  typeof globalThis.requestAnimationFrame === "function" &&
  remainingBudgetMs >= PREVIEW_HOST_RENDERING_PROBE_MS * 2;
