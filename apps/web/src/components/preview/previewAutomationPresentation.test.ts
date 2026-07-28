import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  isPreviewAutomationTabPresented,
  readPreviewAutomationPresentationDiagnostics,
  revealPreviewAutomationTab,
  withPreviewAutomationBackgroundPresentation,
  waitForPreviewAutomationBackgroundPresentation,
} from "./previewAutomationPresentation";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

describe("preview automation presentation", () => {
  beforeEach(() => {
    resetPreviewStateForTests();
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    useRightPanelStore.setState({ byThreadKey: {} });
    useBrowserSurfaceStore.setState({ byTabId: {}, backgroundCaptureCountByTabId: {} });
  });

  it("selects the requested preview tab and its inline preview surface together", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-1", "2026-07-25T00:00:00.000Z"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2", "2026-07-25T00:00:01.000Z"));

    revealPreviewAutomationTab(threadRef, "tab-1");

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      tabId: "tab-1",
    });
    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(false);
    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-1")).toEqual({
      activeSurfaceKind: "inline-preview",
      activeSurfaceId: "mini-player:tab-1",
      inlinePreviewOpen: true,
      inlinePreviewTabId: "tab-1",
      rightPanelOpen: false,
      rightPanelSurfaceId: null,
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });

    const surface = acquireBrowserSurface(
      previewRuntimeTabId(threadRef, readThreadPreviewState(threadRef).serverEpoch, "tab-1"),
    );
    surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);

    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(true);
    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-1")).toMatchObject({
      surfaceRegistered: true,
      presentationRectAvailable: true,
    });

    usePreviewMiniPlayerStore.getState().open(threadRef, "tab-2");
    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(false);
    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-1")).toEqual({
      activeSurfaceKind: "inline-preview",
      activeSurfaceId: "mini-player:tab-2",
      inlinePreviewOpen: true,
      inlinePreviewTabId: "tab-2",
      rightPanelOpen: false,
      rightPanelSurfaceId: null,
      surfaceRegistered: true,
      presentationRectAvailable: true,
    });
    surface.release();
  });

  it("reports presentation precedence and hidden retained panel state", () => {
    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-requested")).toEqual({
      activeSurfaceKind: "none",
      activeSurfaceId: null,
      inlinePreviewOpen: false,
      inlinePreviewTabId: null,
      rightPanelOpen: false,
      rightPanelSurfaceId: null,
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });

    useRightPanelStore.getState().openBrowser(threadRef, "tab-panel");
    usePreviewMiniPlayerStore.getState().open(threadRef, "tab-inline");

    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-requested")).toEqual({
      activeSurfaceKind: "inline-preview",
      activeSurfaceId: "mini-player:tab-inline",
      inlinePreviewOpen: true,
      inlinePreviewTabId: "tab-inline",
      rightPanelOpen: true,
      rightPanelSurfaceId: "browser:tab-panel",
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });

    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().close(threadRef);

    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-requested")).toEqual({
      activeSurfaceKind: "none",
      activeSurfaceId: null,
      inlinePreviewOpen: false,
      inlinePreviewTabId: null,
      rightPanelOpen: false,
      rightPanelSurfaceId: "browser:tab-panel",
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });
  });

  it("reports a right-panel presentation separately from the inline preview", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "tab-panel");

    expect(readPreviewAutomationPresentationDiagnostics(threadRef, "tab-requested")).toEqual({
      activeSurfaceKind: "right-panel",
      activeSurfaceId: "browser:tab-panel",
      inlinePreviewOpen: false,
      inlinePreviewTabId: null,
      rightPanelOpen: true,
      rightPanelSurfaceId: "browser:tab-panel",
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });
  });

  it("uses the operation budget when background staging does not render", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
    });
    vi.stubGlobal("window", {
      setTimeout,
    });
    try {
      const presentation = waitForPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-background",
        tabId: "tab-background",
        timeoutMs: 40,
      });
      const rejection = expect(presentation).rejects.toMatchObject({
        _tag: "PreviewAutomationBackgroundPresentationTimeoutError",
        requestId: "request-background",
        tabId: "tab-background",
        timeoutMs: 40,
      });

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("accepts a tab that becomes foregrounded while background staging renders", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
    });
    vi.stubGlobal("window", {
      setTimeout,
    });
    const surface = acquireBrowserSurface("tab-foregrounded");
    try {
      revealPreviewAutomationTab(threadRef, "tab-foregrounded");
      const presentation = waitForPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-foregrounded",
        tabId: "tab-foregrounded",
        timeoutMs: 40,
      });

      surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);
      await vi.advanceTimersByTimeAsync(16);

      await expect(presentation).resolves.toBeUndefined();
    } finally {
      surface.release();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("stages a visible surface when another inline preview surface is selected", async () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: "tab-background",
            previewBackgroundCapture: "true",
          },
          offsetWidth: 800,
        },
      ],
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    const surface = acquireBrowserSurface("tab-background");
    try {
      surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);
      revealPreviewAutomationTab(threadRef, "tab-foreground");

      const background = await withPreviewAutomationBackgroundPresentation(
        threadRef,
        "request-background",
        "tab-background",
        "tab-background",
        40,
        async (isBackground) => {
          expect(
            useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
          ).toBe(1);
          return isBackground;
        },
      );

      expect(background).toBe(true);
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBeUndefined();
    } finally {
      surface.release();
      vi.unstubAllGlobals();
    }
  });

  it("falls back to frame timers when compositor animation frames remain paused", async () => {
    vi.useFakeTimers();
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: "tab-background",
            previewBackgroundCapture: "true",
          },
          offsetWidth: 800,
        },
      ],
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame,
    });
    const use = vi.fn(async (background: boolean) => background);
    try {
      const operation = withPreviewAutomationBackgroundPresentation(
        threadRef,
        "request-paused-frame",
        "tab-background",
        "tab-background",
        40,
        use,
      );
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBe(1);

      await vi.advanceTimersByTimeAsync(32);
      await expect(operation).resolves.toBe(true);

      expect(use).toHaveBeenCalledWith(true);
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
      expect(cancelAnimationFrame).toHaveBeenNthCalledWith(1, 1);
      expect(cancelAnimationFrame).toHaveBeenNthCalledWith(2, 1);
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("retains a background capture lease until a timed-out operation settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: "tab-background",
            previewBackgroundCapture: "true",
          },
          offsetWidth: 800,
        },
      ],
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    try {
      let settleOperation!: () => void;
      const stalledOperation = new Promise<void>((resolve) => {
        settleOperation = resolve;
      });
      const operation = withPreviewAutomationBackgroundPresentation(
        threadRef,
        "request-stalled",
        "tab-background",
        "tab-background",
        40,
        () => stalledOperation,
      );
      const rejection = expect(operation).rejects.toMatchObject({
        _tag: "PreviewAutomationBackgroundPresentationTimeoutError",
        requestId: "request-stalled",
        tabId: "tab-background",
        timeoutMs: 40,
      });
      await Promise.resolve();
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBe(1);

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBe(1);

      settleOperation();
      await stalledOperation;
      await Promise.resolve();
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId["tab-background"],
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
