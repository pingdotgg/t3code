import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserSurface,
  resolveBrowserSurfacePanelRect,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ byTabId: {} });
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
          hidden: {
            rect: staleRect,
            visible: false,
            content: null,
            fittedSourceContent: null,
            fitSourceContent: false,
            cornerRadius: 0,
            updatedAt: 1,
            owner: null,
          },
          active: {
            rect: liveRect,
            visible: true,
            content: null,
            fittedSourceContent: null,
            fitSourceContent: false,
            cornerRadius: 0,
            updatedAt: 2,
            owner: null,
          },
        },
        "hidden",
      ),
    ).toEqual(liveRect);
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

  it("retains source content while a mini-player fits it into its own surface", () => {
    const tabId = "fitted-browser-surface";
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    const lease = acquireBrowserSurface(tabId, true);
    expect(lease.present({ x: 10, y: 20, width: 320, height: 200 }, true, 12)).toBe(true);
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      fitSourceContent: true,
      fittedSourceContent: { width: 1280, height: 800 },
      cornerRadius: 12,
    });
  });

  it("rejects a displaced surface lease", () => {
    const tabId = "displaced-browser-surface";
    const staleLease = acquireBrowserSurface(tabId);
    const liveLease = acquireBrowserSurface(tabId);

    expect(staleLease.present({ x: 0, y: 0, width: 300, height: 200 }, true)).toBe(false);
    expect(liveLease.present({ x: 10, y: 20, width: 320, height: 240 }, true)).toBe(true);
  });

  it("allows a reclaimed lease to present after displacement", () => {
    const tabId = "reclaimed-browser-surface";
    const first = acquireBrowserSurface(tabId, true);
    expect(first.present({ x: 0, y: 0, width: 320, height: 200 }, true, 12)).toBe(true);

    const second = acquireBrowserSurface(tabId);
    expect(first.present({ x: 0, y: 0, width: 320, height: 200 }, true, 12)).toBe(false);
    expect(second.present({ x: 10, y: 20, width: 400, height: 300 }, false)).toBe(true);

    first.release();
    const reclaimed = acquireBrowserSurface(tabId, true);
    expect(reclaimed.present({ x: 5, y: 5, width: 300, height: 180 }, true, 12)).toBe(true);
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      visible: true,
      fitSourceContent: true,
      cornerRadius: 12,
    });
  });
});
