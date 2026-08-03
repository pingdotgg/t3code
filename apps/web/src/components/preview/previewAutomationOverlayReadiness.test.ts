import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  status: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  readThreadPreviewState: mocks.readThreadPreviewState,
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      status: mocks.status,
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { PreviewAutomationOverlayTimeoutError } from "./previewAutomationErrors";
import { waitForDesktopOverlay } from "./previewAutomationOverlayReadiness";

describe("waitForDesktopOverlay", () => {
  it("clamps overlay polling to a short remaining operation budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
    });
    const threadRef = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab-1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: true,
      },
    });
    mocks.status.mockResolvedValue({ available: false });
    try {
      const overlay = waitForDesktopOverlay(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "open",
        40,
      );
      const rejection = expect(overlay).rejects.toBeInstanceOf(
        PreviewAutomationOverlayTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
