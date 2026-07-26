import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserSurface,
  acquireBrowserSurfaceBackgroundCapture,
  resolveBrowserSurfaceBackgroundCaptureRect,
  resolveBrowserSurfacePanelRect,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ byTabId: {}, backgroundCaptureCountByTabId: {} });
  });

  it("reference-counts background capture leases", () => {
    const releaseFirst = acquireBrowserSurfaceBackgroundCapture("tab-background");
    const releaseSecond = acquireBrowserSurfaceBackgroundCapture("tab-background");

    expect(useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"]).toBe(
      2,
    );

    releaseFirst();
    releaseFirst();
    expect(useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"]).toBe(
      1,
    );

    releaseSecond();
    expect(
      useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
    ).toBeUndefined();
  });

  it("tracks content dimensions for a browser that has never been visible", () => {
    const tabId = "hidden-browser-surface-content-test";
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: 0,
      y: 0,
      width: 393,
      height: 852,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: null,
      visible: false,
      content: { width: 393, height: 852 },
    });
  });

  it("uses the live panel rect for a hidden background tab", () => {
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    expect(
      resolveBrowserSurfacePanelRect(
        {
          hidden: { rect: staleRect, visible: false, content: null, updatedAt: 1, owner: null },
          active: { rect: liveRect, visible: true, content: null, updatedAt: 2, owner: null },
        },
        "hidden",
      ),
    ).toEqual(liveRect);
  });

  it("stages a never-presented background tab inside the renderer viewport", () => {
    expect(
      resolveBrowserSurfaceBackgroundCaptureRect({}, "never-presented", {
        width: 1440,
        height: 900,
      }),
    ).toEqual({
      x: 80,
      y: 50,
      width: 1280,
      height: 800,
    });
  });

  it("fits background capture staging to a smaller renderer viewport", () => {
    expect(
      resolveBrowserSurfaceBackgroundCaptureRect({}, "never-presented", {
        width: 800,
        height: 600,
      }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("clamps a stale presented rectangle to the current renderer viewport", () => {
    expect(
      resolveBrowserSurfaceBackgroundCaptureRect(
        {
          active: {
            rect: { x: 1_000, y: 700, width: 900, height: 640 },
            visible: true,
            content: null,
            updatedAt: 1,
            owner: null,
          },
        },
        "hidden",
        { width: 800, height: 600 },
      ),
    ).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("ignores updates and releases from a stale surface lease", () => {
    const tabId = "leased-browser-surface";
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    const staleLease = acquireBrowserSurface(tabId);
    staleLease.present(staleRect, true);

    const liveLease = acquireBrowserSurface(tabId);
    liveLease.present(liveRect, true);
    staleLease.present(staleRect, true);
    staleLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
    });
  });

  it("hides a surface when its current lease is released", () => {
    const tabId = "released-browser-surface";
    const lease = acquireBrowserSurface(tabId);
    lease.present({ x: 10, y: 20, width: 900, height: 640 }, true);

    lease.release();
    lease.present({ x: 0, y: 0, width: 1, height: 1 }, true);

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      visible: false,
      owner: null,
    });
  });
});
