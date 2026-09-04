import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
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
      evaluate: vi.fn(),
      status: vi.fn(),
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { previewBridge } from "./previewBridge";
import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
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
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  it("falls back to a fresh overlay read when attached is absent", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: { hasWebContents: true },
      },
    });
    vi.mocked(previewBridge!.automation.status).mockResolvedValue({
      available: false,
      visible: true,
      tabId,
      url: "http://localhost:5173/",
      title: "ERR_CONNECTION_REFUSED",
      loading: false,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        2_000,
      ),
    ).resolves.toBeUndefined();
  });

  it("settles a failed navigation instead of waiting for availability", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: { hasWebContents: true },
      },
    });
    vi.mocked(previewBridge!.automation.status).mockResolvedValue({
      available: false,
      visible: true,
      tabId,
      url: "http://localhost:5173/",
      title: "ERR_CONNECTION_REFUSED",
      loading: false,
      attached: true,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        2_000,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a detached guest instead of treating it as a finished load", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: { hasWebContents: false },
      },
    });
    vi.mocked(previewBridge!.automation.status).mockResolvedValue({
      available: false,
      visible: true,
      tabId,
      url: "http://localhost:5173/",
      title: null,
      loading: false,
      attached: false,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        2_000,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  it("rejects a destroyed guest even when the overlay still reports webContents", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: { hasWebContents: true },
      },
    });
    vi.mocked(previewBridge!.automation.status).mockResolvedValue({
      available: false,
      visible: true,
      tabId,
      url: "http://localhost:5173/",
      title: "ERR_CONNECTION_REFUSED",
      loading: false,
      attached: false,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        2_000,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  it("settles a failed navigation from attached even if the overlay lags", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
      desktopByTabId: {
        [tabId]: { hasWebContents: false },
      },
    });
    vi.mocked(previewBridge!.automation.status).mockResolvedValue({
      available: false,
      visible: true,
      tabId,
      url: "http://localhost:5173/",
      title: "ERR_CONNECTION_REFUSED",
      loading: false,
      attached: true,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        2_000,
      ),
    ).resolves.toBeUndefined();
  });
});
