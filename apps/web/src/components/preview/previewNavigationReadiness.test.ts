import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  evaluate: vi.fn(),
  status: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: mocks.evaluate,
      status: mocks.status,
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import {
  withCurrentPreviewRuntime,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment-2"),
    threadId: ThreadId.make("thread-1"),
  };
  const tabId = "tab_1";
  const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);

  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  it.each([
    ["domContentLoaded", "evaluate", "interactive"],
    ["load", "status", { available: true, loading: false }],
  ] as const)(
    "rejects %s readiness when the runtime changes during %s",
    async (readiness, method, result) => {
      let resolve: ((value: typeof result) => void) | undefined;
      const pending = new Promise<typeof result>((next) => {
        resolve = next;
      });
      mocks.readThreadPreviewState
        .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } })
        .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } })
        .mockReturnValueOnce({ serverEpoch: "epoch-2", sessions: { [tabId]: { tabId } } });
      mocks[method].mockReturnValueOnce(pending);

      const readinessPromise = waitForNavigationReadiness(
        threadRef,
        `request-${method}`,
        tabId,
        runtimeTabId,
        "navigate",
        readiness,
        100,
      );
      resolve?.(result);

      await expect(readinessPromise).rejects.toBeInstanceOf(
        PreviewAutomationTargetUnavailableError,
      );
    },
  );

  it("rejects a desktop status result from a replaced runtime", async () => {
    let resolve: ((value: { available: boolean; loading: boolean }) => void) | undefined;
    const pending = new Promise<{ available: boolean; loading: boolean }>((next) => {
      resolve = next;
    });
    mocks.readThreadPreviewState
      .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } })
      .mockReturnValueOnce({ serverEpoch: "epoch-2", sessions: { [tabId]: { tabId } } });
    mocks.status.mockReturnValueOnce(pending);

    const statusPromise = withCurrentPreviewRuntime(
      threadRef,
      tabId,
      runtimeTabId,
      { operation: "status", requestId: "request-desktop-status" },
      () => mocks.status(runtimeTabId),
    );
    resolve?.({ available: true, loading: false });

    await expect(statusPromise).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});
