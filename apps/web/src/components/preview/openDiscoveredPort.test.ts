import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  acquireDiscoveredServerRoute: vi.fn(),
  commit: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  openBrowser: vi.fn(),
  openPreviewSession: vi.fn(),
}));

vi.mock("~/browser/browserTargetResolver", () => ({
  acquireDiscoveredServerRoute: mocks.acquireDiscoveredServerRoute,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));
vi.mock("./openPreviewSession", () => ({ openPreviewSession: mocks.openPreviewSession }));

import { openDiscoveredPort } from "./openDiscoveredPort";

const threadRef = {
  environmentId: "environment-1",
  threadId: "thread-1",
} as ScopedThreadRef;

const snapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Success", url: "http://127.0.0.1:42173/", title: "App" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-07-16T00:00:00.000Z",
} satisfies PreviewSessionSnapshot;

describe("openDiscoveredPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireDiscoveredServerRoute.mockResolvedValue({
      resolution: { resolvedUrl: "http://127.0.0.1:42173/" },
      commit: mocks.commit,
      release: mocks.release,
    });
    mocks.openPreviewSession.mockResolvedValue(AsyncResult.success(snapshot));
  });

  it("holds the route through preview creation and transfers it to the new tab", async () => {
    const result = await openDiscoveredPort({
      threadRef,
      port: {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/",
        processName: null,
        pid: null,
        terminal: null,
      },
      openPreview: vi.fn(),
    });

    expect(result._tag).toBe("Success");
    expect(mocks.acquireDiscoveredServerRoute).toHaveBeenCalledWith(
      threadRef.environmentId,
      "http://localhost:5173/",
    );
    expect(mocks.openPreviewSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:42173/" }),
    );
    expect(mocks.commit).toHaveBeenCalledWith("tab-1");
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
  });

  it("reports route acquisition failures as command failures", async () => {
    mocks.acquireDiscoveredServerRoute.mockRejectedValueOnce(new Error("forward failed"));

    const result = await openDiscoveredPort({
      threadRef,
      port: {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/",
        processName: null,
        pid: null,
        terminal: null,
      },
      openPreview: vi.fn(),
    });

    expect(result._tag).toBe("Failure");
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });
});
