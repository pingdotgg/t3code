import { DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { installDesktopScreenshotActivity } from "./desktopScreenshotActivity";

it("retains overlapping screenshot and recording activity until each owner releases it", () => {
  using stack = new DisposableStack();
  const recording = useBrowserSurfaceStore.getState().acquireActivity("capture-tab");
  stack.defer(recording);
  stack.defer(installDesktopScreenshotActivity((tabId) => tabId === "capture-tab"));
  const activity = Reflect.get(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY);
  expect(activity("capture-tab", "first", true)).toBe(true);
  expect(activity("capture-tab", "second", true)).toBe(true);
  expect(activity("capture-tab", "first", true)).toBe(true);
  expect(useBrowserSurfaceStore.getState().activityByTabId["capture-tab"]).toBe(3);
  activity("capture-tab", "first", false);
  activity("capture-tab", "first", false);
  expect(useBrowserSurfaceStore.getState().activityByTabId["capture-tab"]).toBe(2);
  activity("capture-tab", "second", false);
  expect(useBrowserSurfaceStore.getState().activityByTabId["capture-tab"]).toBe(1);
});

it("rejects unknown tabs and prevents one tab from releasing another tab's token", () => {
  using stack = new DisposableStack();
  stack.defer(installDesktopScreenshotActivity((tabId) => tabId === "capture-tab"));
  const activity = Reflect.get(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY);
  expect(activity("unknown", "first", true)).toBe(false);
  expect(activity("capture-tab", "first", true)).toBe(true);
  expect(activity("other-tab", "first", false)).toBe(false);
  expect(useBrowserSurfaceStore.getState().activityByTabId["capture-tab"]).toBe(1);
});

it("releases outstanding tokens when the desktop host unmounts", () => {
  const dispose = installDesktopScreenshotActivity(() => true);
  const activity = Reflect.get(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY);
  activity("capture-tab", "first", true);
  dispose();
  expect(useBrowserSurfaceStore.getState().activityByTabId["capture-tab"]).toBeUndefined();
  expect(Reflect.has(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY)).toBe(false);
});
