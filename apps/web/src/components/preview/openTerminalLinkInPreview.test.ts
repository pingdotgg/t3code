import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canOpenTerminalLinkInPreview,
  openTerminalLinkInPreview,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

const previewSupported = vi.hoisted(() => ({ value: true }));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => previewSupported.value,
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
  previewSupported.value = true;
  vi.restoreAllMocks();
});

describe("canOpenTerminalLinkInPreview", () => {
  it("keeps loopback URLs in preview and sends public URLs to the host browser", () => {
    expect(canOpenTerminalLinkInPreview("http://localhost:3000/app", threadRef)).toBe(true);
    expect(canOpenTerminalLinkInPreview("https://example.com/docs", threadRef)).toBe(false);
  });
});

describe("openTerminalLinkInPreview", () => {
  it("falls back without opening preview when the URL is not previewable", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("preserves the complete preview failure cause before falling back", async () => {
    const rpcError = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpcError), Cause.die("preview defect"));
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://127.0.0.1:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(cause),
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
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });
});
