import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PREVIEW_HOST_RENDERING_PROBE_MS,
  canProbePreviewHostRendering,
  measurePreviewHostRendering,
} from "./previewHostRendering";

describe("measurePreviewHostRendering", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let frameCallbacks: Array<{ id: number; callback: FrameRequestCallback }> = [];
  let nextFrameId = 1;
  const cancelAnimationFrame = vi.fn((id: number) => {
    frameCallbacks = frameCallbacks.filter((entry) => entry.id !== id);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    frameCallbacks = [];
    nextFrameId = 1;
    cancelAnimationFrame.mockClear();
    globalThis.requestAnimationFrame = (callback) => {
      const id = nextFrameId++;
      frameCallbacks.push({ id, callback });
      return id;
    };
    globalThis.cancelAnimationFrame = cancelAnimationFrame;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("reports a hidden host as paused without waiting for a throttled timer", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });

    await expect(measurePreviewHostRendering()).resolves.toBe("paused");

    expect(frameCallbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an active host once an animation frame fires within the bound", async () => {
    const measurement = measurePreviewHostRendering();
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks[0]!.callback(16);
    await expect(measurement).resolves.toBe("active");
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a paused host and cancels the frame request when no frame arrives", async () => {
    const measurement = measurePreviewHostRendering();
    await vi.advanceTimersByTimeAsync(PREVIEW_HOST_RENDERING_PROBE_MS);
    await expect(measurement).resolves.toBe("paused");
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frameCallbacks).toHaveLength(0);
  });

  it("only probes when the request budget leaves room for the answer", () => {
    expect(canProbePreviewHostRendering(PREVIEW_HOST_RENDERING_PROBE_MS * 2)).toBe(true);
    expect(canProbePreviewHostRendering(PREVIEW_HOST_RENDERING_PROBE_MS * 2 - 1)).toBe(false);
    expect(canProbePreviewHostRendering(0)).toBe(false);
  });
});
