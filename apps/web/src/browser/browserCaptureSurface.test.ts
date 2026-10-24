import { DESKTOP_PREVIEW_CAPTURE_SURFACE_TRIGGER } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { installBrowserCaptureSurface } from "./browserCaptureSurface";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";

function setup() {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", {
    querySelectorAll: () =>
      [42, 43].map((id) => ({
        getWebContentsId: () => id,
        dataset: { previewTab: `tab-${id}` },
        closest: () => ({ getBoundingClientRect: () => ({ width: 1280, height: 800 }) }),
      })),
  });
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  const dispose = installBrowserCaptureSurface();
  const setSurface = Reflect.get(globalThis, DESKTOP_PREVIEW_CAPTURE_SURFACE_TRIGGER) as (
    webContentsId: number,
    captureId: string,
    active: boolean,
  ) => Promise<boolean>;
  return {
    setSurface,
    dispose,
    paint: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    [Symbol.dispose]() {
      dispose();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

it("activates only the captured tab and preserves another consumer when capture ends", async () => {
  using surface = setup();
  const releaseRecording = acquireBrowserSurfaceActivity("tab-42");
  const ready = surface.setSurface(42, "capture-1", true);
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({ "tab-42": 2 });
  surface.paint();
  surface.paint();
  expect(await ready).toBe(true);

  await surface.setSurface(42, "capture-1", false);
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({ "tab-42": 1 });
  releaseRecording();
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({});
});

it("releases a tab whose embedder never paints", async () => {
  using surface = setup();
  const ready = surface.setSurface(42, "capture-1", true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await ready).toBe(false);
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({});
});

it("bounds rendering for an abandoned capture and releases pending work on teardown", async () => {
  using surface = setup();
  const ready = surface.setSurface(42, "capture-1", true);
  surface.paint();
  surface.paint();
  expect(await ready).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({});

  const pending = surface.setSurface(43, "capture-2", true);
  surface.dispose();
  expect(await pending).toBe(false);
  expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({});
});
