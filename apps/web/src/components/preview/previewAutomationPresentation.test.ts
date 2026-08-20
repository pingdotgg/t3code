import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  isPreviewAutomationTabPresented,
  readPreviewAutomationPresentationDiagnostics,
  revealPreviewAutomationTab,
  waitForBrowserSurfaceVisibility,
  waitForPreviewPresentation,
  withPreviewAutomationBackgroundPresentation,
  waitForPreviewAutomationBackgroundPresentation,
} from "./previewAutomationPresentation";
import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

const presentationTarget = (tabId: string, runtimeTabId: string) => ({
  threadRef,
  tabId,
  runtimeTabId,
});

const addRuntimeTab = (tabId: string): string => {
  applyPreviewServerSnapshot(threadRef, snapshot(tabId, "2026-07-25T00:00:00.000Z"));
  return previewRuntimeTabId(threadRef, readThreadPreviewState(threadRef).serverEpoch, tabId);
};

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
    const tabOneRuntimeId = previewRuntimeTabId(
      threadRef,
      readThreadPreviewState(threadRef).serverEpoch,
      "tab-1",
    );

    revealPreviewAutomationTab(threadRef, "tab-1");

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      tabId: "tab-1",
    });
    expect(isPreviewAutomationTabPresented(presentationTarget("tab-1", tabOneRuntimeId))).toBe(
      false,
    );
    expect(
      readPreviewAutomationPresentationDiagnostics(presentationTarget("tab-1", tabOneRuntimeId)),
    ).toEqual({
      activeSurfaceKind: "inline-preview",
      activeSurfaceId: "mini-player:tab-1",
      inlinePreviewOpen: true,
      inlinePreviewTabId: "tab-1",
      rightPanelOpen: false,
      rightPanelSurfaceId: null,
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });

    const serverIdSurface = acquireBrowserSurface("tab-1");
    serverIdSurface.present({ x: 0, y: 0, width: 800, height: 600 }, true);
    expect(isPreviewAutomationTabPresented(presentationTarget("tab-1", tabOneRuntimeId))).toBe(
      false,
    );
    expect(
      readPreviewAutomationPresentationDiagnostics(presentationTarget("tab-1", tabOneRuntimeId)),
    ).toMatchObject({
      surfaceRegistered: false,
      presentationRectAvailable: false,
    });
    serverIdSurface.release();

    const surface = acquireBrowserSurface(tabOneRuntimeId);
    surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);

    expect(isPreviewAutomationTabPresented(presentationTarget("tab-1", tabOneRuntimeId))).toBe(
      true,
    );
    expect(
      readPreviewAutomationPresentationDiagnostics(presentationTarget("tab-1", tabOneRuntimeId)),
    ).toMatchObject({
      surfaceRegistered: true,
      presentationRectAvailable: true,
    });

    usePreviewMiniPlayerStore.getState().open(threadRef, "tab-2");
    expect(isPreviewAutomationTabPresented(presentationTarget("tab-1", tabOneRuntimeId))).toBe(
      false,
    );
    expect(
      readPreviewAutomationPresentationDiagnostics(presentationTarget("tab-1", tabOneRuntimeId)),
    ).toEqual({
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
    expect(
      readPreviewAutomationPresentationDiagnostics(
        presentationTarget("tab-requested", "runtime-requested"),
      ),
    ).toEqual({
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

    expect(
      readPreviewAutomationPresentationDiagnostics(
        presentationTarget("tab-requested", "runtime-requested"),
      ),
    ).toEqual({
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

    expect(
      readPreviewAutomationPresentationDiagnostics(
        presentationTarget("tab-requested", "runtime-requested"),
      ),
    ).toEqual({
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

    expect(
      readPreviewAutomationPresentationDiagnostics(
        presentationTarget("tab-requested", "runtime-requested"),
      ),
    ).toEqual({
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
    const runtimeTabId = addRuntimeTab("tab-background");
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
        runtimeTabId,
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

  it("clamps open visibility polling to the remaining operation budget", async () => {
    vi.useFakeTimers();
    const runtimeTabId = addRuntimeTab("tab-open");
    vi.stubGlobal("window", {
      setTimeout,
    });
    try {
      const visibility = waitForBrowserSurfaceVisibility({
        threadRef,
        requestId: "request-open",
        tabId: "tab-open",
        runtimeTabId,
        timeoutMs: 40,
      });
      const rejection = expect(visibility).rejects.toMatchObject({
        _tag: "PreviewAutomationVisibilityTimeoutError",
        requestId: "request-open",
        tabId: "tab-open",
        timeoutMs: 40,
      });

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not reopen the inline preview while the right panel selects the tab", async () => {
    vi.useFakeTimers();
    const tabId = "tab-panel-open";
    const runtimeTabId = addRuntimeTab(tabId);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
    const panelSurface = acquireBrowserSurface(runtimeTabId);
    panelSurface.present({ x: 0, y: 0, width: 800, height: 600 }, false);
    const panelOwner = useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.owner;
    vi.stubGlobal("window", {
      setTimeout,
    });
    try {
      const visibility = waitForBrowserSurfaceVisibility({
        threadRef,
        requestId: "request-panel-open",
        tabId,
        runtimeTabId,
        timeoutMs: 100,
      });
      const rejection = expect(visibility).rejects.toMatchObject({
        _tag: "PreviewAutomationVisibilityTimeoutError",
        requestId: "request-panel-open",
        tabId,
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(
        selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
      ).toBeNull();
      expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.owner).toBe(panelOwner);
    } finally {
      panelSurface.release();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("clamps best-effort presentation settling to the remaining operation budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
    });
    try {
      const settled = vi.fn();
      const presentation = waitForPreviewPresentation("tab-open", 40).then(settled);

      await vi.advanceTimersByTimeAsync(39);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await presentation;
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects an open visibility wait when the runtime guest is replaced", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
    });
    const tabId = "tab-open";
    const serverSnapshot = snapshot(tabId, "2026-07-25T00:00:00.000Z");
    reconcilePreviewServerSessions(threadRef, {
      sessions: [serverSnapshot],
      serverEpoch: "epoch-1",
      revision: 1,
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    try {
      const visibility = waitForBrowserSurfaceVisibility({
        threadRef,
        requestId: "request-open",
        tabId,
        runtimeTabId,
        timeoutMs: 500,
      });
      const rejection = expect(visibility).rejects.toBeInstanceOf(
        PreviewAutomationTargetUnavailableError,
      );

      reconcilePreviewServerSessions(threadRef, {
        sessions: [serverSnapshot],
        serverEpoch: "epoch-2",
        revision: 0,
      });
      await vi.advanceTimersByTimeAsync(50);

      await rejection;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects background staging when the runtime guest is replaced", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
    });
    vi.stubGlobal("window", {
      setTimeout,
    });
    const tabId = "tab-background";
    const serverSnapshot = snapshot(tabId, "2026-07-25T00:00:00.000Z");
    reconcilePreviewServerSessions(threadRef, {
      sessions: [serverSnapshot],
      serverEpoch: "epoch-1",
      revision: 1,
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    try {
      const presentation = waitForPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-background",
        tabId,
        runtimeTabId,
        timeoutMs: 500,
      });
      const rejection = expect(presentation).rejects.toBeInstanceOf(
        PreviewAutomationTargetUnavailableError,
      );

      reconcilePreviewServerSessions(threadRef, {
        sessions: [serverSnapshot],
        serverEpoch: "epoch-2",
        revision: 0,
      });
      await vi.advanceTimersByTimeAsync(16);

      await rejection;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("accepts a tab that becomes foregrounded while background staging renders", async () => {
    vi.useFakeTimers();
    const runtimeTabId = addRuntimeTab("tab-foregrounded");
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
    });
    vi.stubGlobal("window", {
      setTimeout,
    });
    const surface = acquireBrowserSurface(runtimeTabId);
    try {
      revealPreviewAutomationTab(threadRef, "tab-foregrounded");
      const presentation = waitForPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-foregrounded",
        tabId: "tab-foregrounded",
        runtimeTabId,
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
    const runtimeTabId = addRuntimeTab("tab-background");
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: runtimeTabId,
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
    const surface = acquireBrowserSurface(runtimeTabId);
    try {
      surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);
      revealPreviewAutomationTab(threadRef, "tab-foreground");

      const background = await withPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-background",
        tabId: "tab-background",
        runtimeTabId,
        timeoutMs: 40,
        use: async (isBackground) => {
          expect(
            useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId],
          ).toBe(1);
          return isBackground;
        },
      });

      expect(background).toBe(true);
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId],
      ).toBeUndefined();
    } finally {
      surface.release();
      vi.unstubAllGlobals();
    }
  });

  it("falls back to frame timers when compositor animation frames remain paused", async () => {
    vi.useFakeTimers();
    const runtimeTabId = addRuntimeTab("tab-background");
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: runtimeTabId,
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
      const operation = withPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-paused-frame",
        tabId: "tab-background",
        runtimeTabId,
        timeoutMs: 40,
        use,
      });
      expect(useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId]).toBe(1);

      await vi.advanceTimersByTimeAsync(32);
      await expect(operation).resolves.toBe(true);

      expect(use).toHaveBeenCalledWith(true);
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
      expect(cancelAnimationFrame).toHaveBeenNthCalledWith(1, 1);
      expect(cancelAnimationFrame).toHaveBeenNthCalledWith(2, 1);
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId],
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("retains a background capture lease until a timed-out operation settles", async () => {
    vi.useFakeTimers();
    const runtimeTabId = addRuntimeTab("tab-background");
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: runtimeTabId,
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
      const operation = withPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-stalled",
        tabId: "tab-background",
        runtimeTabId,
        timeoutMs: 40,
        use: () => stalledOperation,
      });
      const rejection = expect(operation).rejects.toMatchObject({
        _tag: "PreviewAutomationBackgroundPresentationTimeoutError",
        requestId: "request-stalled",
        tabId: "tab-background",
        timeoutMs: 40,
      });
      await Promise.resolve();
      expect(useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId]).toBe(1);

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
      expect(useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId]).toBe(1);

      settleOperation();
      await stalledOperation;
      await Promise.resolve();
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId],
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("handles a delayed capture rejection after the presentation deadline wins", async () => {
    vi.useFakeTimers();
    const runtimeTabId = addRuntimeTab("tab-background");
    vi.stubGlobal("document", {
      querySelectorAll: () => [
        {
          dataset: {
            previewViewport: runtimeTabId,
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
      let rejectOperation!: (cause: Error) => void;
      const stalledOperation = new Promise<void>((_resolve, reject) => {
        rejectOperation = reject;
      });
      const operation = withPreviewAutomationBackgroundPresentation({
        threadRef,
        requestId: "request-rejected-after-timeout",
        tabId: "tab-background",
        runtimeTabId,
        timeoutMs: 40,
        use: () => stalledOperation,
      });
      const rejection = expect(operation).rejects.toMatchObject({
        _tag: "PreviewAutomationBackgroundPresentationTimeoutError",
        requestId: "request-rejected-after-timeout",
        tabId: "tab-background",
        timeoutMs: 40,
      });

      await vi.advanceTimersByTimeAsync(40);
      await rejection;

      rejectOperation(new Error("delayed desktop capture failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(
        useBrowserSurfaceStore.getState().backgroundCaptureCountByTabId[runtimeTabId],
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
