import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserSurface,
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  it("keeps concurrent background work active until every lease is released", () => {
    const first = acquireBrowserSurfaceActivity("background-browser");
    const second = acquireBrowserSurfaceActivity("background-browser");

    first();
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-browser"]).toBe(1);

    second();
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-browser"]).toBeUndefined();
  });

  it("freezes the source content dimensions for a fitted presentation", () => {
    const tabId = "fitted-browser-surface";
    const sourceOwner = Symbol("source");
    const sourceContent = {
      x: 10,
      y: 20,
      width: 1_280,
      height: 720,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    };
    useBrowserSurfaceStore.getState().claim(tabId, sourceOwner, false);
    useBrowserSurfaceStore.getState().presentContent(tabId, sourceContent);

    const fittedLease = acquireBrowserSurface(tabId, true);
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      ...sourceContent,
      width: 360,
      height: 203,
      scale: 0.28125,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.fittedSourceContent).toEqual(
      sourceContent,
    );
    fittedLease.release();
  });

  it("ignores updates and releases from a stale surface lease", () => {
    const tabId = "leased-browser-surface";
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    const staleLease = acquireBrowserSurface(tabId);
    staleLease.present(staleRect, true);

    const liveLease = acquireBrowserSurface(tabId);
    liveLease.present(liveRect, true);
    expect(staleLease.present(staleRect, true)).toBe(false);
    staleLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
    });
  });
});
