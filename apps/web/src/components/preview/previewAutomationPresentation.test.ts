import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  isPreviewAutomationTabPresented,
  revealPreviewAutomationTab,
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
    useRightPanelStore.setState({ byThreadKey: {} });
    useBrowserSurfaceStore.setState({ byTabId: {}, backgroundCaptureCountByTabId: {} });
  });

  it("selects the requested preview tab and its right-panel surface together", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-1", "2026-07-25T00:00:00.000Z"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2", "2026-07-25T00:00:01.000Z"));

    revealPreviewAutomationTab(threadRef, "tab-1");

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:tab-1",
    });
    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(false);

    const surface = acquireBrowserSurface("tab-1");
    surface.present({ x: 0, y: 0, width: 800, height: 600 }, true);

    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(true);

    useRightPanelStore.getState().openBrowser(threadRef, "tab-2");
    expect(isPreviewAutomationTabPresented(threadRef, "tab-1")).toBe(false);
    surface.release();
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
});
