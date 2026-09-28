import {
  EnvironmentId,
  PreviewAutomationManagedTargetAuthError,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  evaluate: vi.fn(),
  status: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    automation: {
      evaluate: mocks.evaluate,
      status: mocks.status,
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import {
  withCurrentPreviewRuntime,
  waitForManagedPreviewReadiness,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment-2"),
    threadId: ThreadId.make("thread-1"),
  };
  const tabId = "tab_1";
  const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);

  beforeEach(() => {
    mocks.readThreadPreviewState.mockReset();
    mocks.evaluate.mockReset();
    mocks.status.mockReset();
    mocks.navigate.mockReset();
  });

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

  it("resolves networkIdle when the page is complete and quiet", async () => {
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: { [tabId]: { tabId } },
    });
    mocks.status.mockResolvedValue({ available: true, loading: false });
    mocks.evaluate.mockResolvedValue({
      readyState: "complete",
      msSinceLastResource: 600,
      nowMs: 1_000,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-network-idle-ok",
        tabId,
        runtimeTabId,
        "navigate",
        "networkIdle",
        500,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.status).toHaveBeenCalled();
    expect(mocks.evaluate).toHaveBeenCalled();
  });

  it("keeps polling networkIdle while recent network activity exists", async () => {
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: { [tabId]: { tabId } },
    });
    mocks.status.mockResolvedValue({ available: true, loading: false });
    mocks.evaluate
      .mockResolvedValueOnce({
        readyState: "complete",
        msSinceLastResource: 50,
        nowMs: 1_000,
      })
      .mockResolvedValueOnce({
        readyState: "complete",
        msSinceLastResource: 700,
        nowMs: 1_200,
      });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-network-idle-poll",
        tabId,
        runtimeTabId,
        "navigate",
        "networkIdle",
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
  });

  it("times out networkIdle when the page never quiets", async () => {
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: { [tabId]: { tabId } },
    });
    mocks.status.mockResolvedValue({ available: true, loading: true });
    mocks.evaluate.mockResolvedValue({
      readyState: "interactive",
      msSinceLastResource: 10,
      nowMs: 100,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-network-idle-timeout",
        tabId,
        runtimeTabId,
        "navigate",
        "networkIdle",
        120,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationNavigationTimeoutError);
  });

  it("rejects networkIdle when the runtime is replaced between status and evaluate", async () => {
    mocks.readThreadPreviewState
      .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } }) // initial assert
      .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } }) // status before
      .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } }) // status after
      .mockReturnValueOnce({ serverEpoch: "epoch-1", sessions: { [tabId]: { tabId } } }) // evaluate before
      .mockReturnValueOnce({ serverEpoch: "epoch-2", sessions: { [tabId]: { tabId } } }); // evaluate after
    mocks.status.mockResolvedValue({ available: true, loading: false });
    mocks.evaluate.mockResolvedValue({
      readyState: "complete",
      msSinceLastResource: 900,
      nowMs: 1_000,
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-network-idle-replaced",
        tabId,
        runtimeTabId,
        "navigate",
        "networkIdle",
        500,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});

describe("waitForManagedPreviewReadiness", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment-2"),
    threadId: ThreadId.make("thread-1"),
  };
  const tabId = "tab_1";
  const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
  const request = { operation: "open" as const, requestId: "request-managed-preview" };
  const target = {
    environmentId: threadRef.environmentId,
    expectedOrigins: ["http://127.0.0.1:6270"],
  };
  const targetUrl = "http://127.0.0.1:6270/";

  beforeEach(() => {
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: { [tabId]: { tabId } },
    });
    mocks.evaluate.mockReset();
    mocks.navigate.mockReset();
  });

  it("recovers once from a pairing page and waits for authenticated app readiness", async () => {
    mocks.evaluate
      .mockResolvedValueOnce({
        status: "unauthenticated",
        pairingPage: true,
        appReady: true,
        reason: "missing",
      })
      .mockResolvedValueOnce({
        status: "authenticated",
        pairingPage: false,
        appReady: true,
      });
    mocks.navigate.mockResolvedValue(undefined);

    await expect(
      waitForManagedPreviewReadiness({
        threadRef,
        request,
        tabId,
        runtimeTabId,
        target,
        targetUrl,
        timeoutMs: 500,
        recoverPairingPage: true,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith(runtimeTabId, targetUrl);
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
  });

  it("does not accept an authenticated pairing page as application readiness", async () => {
    mocks.evaluate.mockResolvedValue({
      status: "authenticated",
      pairingPage: true,
      appReady: true,
    });

    await expect(
      waitForManagedPreviewReadiness({
        threadRef,
        request,
        tabId,
        runtimeTabId,
        target,
        targetUrl: `${targetUrl}pair`,
        timeoutMs: 500,
        recoverPairingPage: true,
      }),
    ).rejects.toMatchObject({
      reason: "pairing-required",
    } satisfies Partial<PreviewAutomationManagedTargetAuthError>);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not recover or reauthorize revoked access", async () => {
    mocks.evaluate.mockResolvedValue({
      status: "unauthenticated",
      pairingPage: true,
      appReady: true,
      reason: "revoked",
    });

    await expect(
      waitForManagedPreviewReadiness({
        threadRef,
        request,
        tabId,
        runtimeTabId,
        target,
        targetUrl,
        timeoutMs: 500,
        recoverPairingPage: true,
      }),
    ).rejects.toMatchObject({
      reason: "session-revoked",
    } satisfies Partial<PreviewAutomationManagedTargetAuthError>);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("rejects a page on an origin outside the managed target", async () => {
    mocks.evaluate.mockResolvedValue({
      status: "origin-mismatch",
      pairingPage: false,
      appReady: false,
    });

    await expect(
      waitForManagedPreviewReadiness({
        threadRef,
        request,
        tabId,
        runtimeTabId,
        target,
        targetUrl,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      reason: "target-origin-mismatch",
    } satisfies Partial<PreviewAutomationManagedTargetAuthError>);
  });
});
