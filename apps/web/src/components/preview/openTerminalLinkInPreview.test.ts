import type { LocalApi, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openTerminalLinkInPreview,
  TerminalLinkContextMenuShowError,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => true,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: vi.fn() }),
  },
}));

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

    await openTerminalLinkInPreview({
      url: "http://127.0.0.1:5173/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview: async () => AsyncResult.failure(cause),
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
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

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      position: { x: 12, y: 34 },
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      localApi: {
        contextMenu: {
          show: vi.fn(async () => "open-in-preview"),
        },
      } as unknown as LocalApi,
      fallbackToBrowser,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });
});
