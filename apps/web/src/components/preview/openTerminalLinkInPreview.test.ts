import type { LocalApi, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  acquireDiscoveredServerRoute: vi.fn(),
  BrowserNavigationRouteAcquireInterrupted: class extends Error {},
  commit: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  openBrowser: vi.fn(),
  openPreviewSession: vi.fn(),
}));

vi.mock("~/browser/browserTargetResolver", () => ({
  acquireDiscoveredServerRoute: mocks.acquireDiscoveredServerRoute,
  BrowserNavigationRouteAcquireInterrupted: mocks.BrowserNavigationRouteAcquireInterrupted,
}));

import {
  openTerminalLinkInPreview,
  TerminalLinkContextMenuShowError,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => true,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: mocks.openBrowser }),
  },
}));

vi.mock("./openPreviewSession", () => ({ openPreviewSession: mocks.openPreviewSession }));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-20T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireDiscoveredServerRoute.mockResolvedValue({
    resolution: { resolvedUrl: "http://127.0.0.1:42173/" },
    commit: mocks.commit,
    release: mocks.release,
  });
  mocks.openPreviewSession.mockResolvedValue(AsyncResult.success(snapshot));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openTerminalLinkInPreview", () => {
  it("preserves context-menu failures with terminal link context before falling back", async () => {
    const cause = new Error("menu unavailable");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/path?token=secret",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview,
      localApi: {
        contextMenu: {
          show: vi.fn(async () => {
            throw cause;
          }),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
    expect(mocks.acquireDiscoveredServerRoute).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
    const error = reportError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TerminalLinkContextMenuShowError);
    expect(error).toMatchObject({
      environmentId: "local",
      threadId: "thread-1",
      targetOrigin: "http://localhost:3000",
      cause,
    });
    expect(error.message).not.toContain("menu unavailable");
    expect(error.targetOrigin).not.toContain("secret");
  });

  it("preserves the complete preview failure cause before falling back", async () => {
    const rpcError = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpcError), Cause.die("preview defect"));
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.openPreviewSession.mockResolvedValueOnce(AsyncResult.failure(cause));

    await openTerminalLinkInPreview({
      url: "http://127.0.0.1:5173/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview: vi.fn(),
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    const error = reportError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TerminalLinkPreviewOpenError);
    expect(error).toMatchObject({
      environmentId: "local",
      threadId: "thread-1",
      targetOrigin: "http://127.0.0.1:5173",
      cause,
    });
    expect(error.message).not.toContain("preview unavailable");
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.openPreviewSession.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview: vi.fn(),
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not report or fall back when route acquisition is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.acquireDiscoveredServerRoute.mockRejectedValueOnce(
      new mocks.BrowserNavigationRouteAcquireInterrupted(),
    );

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview: vi.fn(),
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });

  it("routes localhost links before opening the preview and retains the route for its tab", async () => {
    const openPreview = vi.fn();
    const fallbackToBrowser = vi.fn();

    await openTerminalLinkInPreview({
      url: "http://localhost:4321/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview,
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(mocks.acquireDiscoveredServerRoute).toHaveBeenCalledWith(
      threadRef.environmentId,
      "http://localhost:4321/",
    );
    expect(mocks.openPreviewSession).toHaveBeenCalledWith({
      openPreview,
      threadRef,
      url: "http://127.0.0.1:42173/",
    });
    expect(mocks.commit).toHaveBeenCalledWith("tab-1");
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });
});
