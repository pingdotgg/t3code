import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  BrowserPreviewUnavailableError,
  isBrowserPreviewAssetUrlInvalidError,
  type OpenPreviewMutation,
  openFileInPreview,
  openUrlInPreview,
} from "./openFileInPreview";

const threadRef = {
  environmentId: "environment-1" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string, url: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-21T00:00:00.000Z",
});

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe("openFileInPreview", () => {
  it("reports an unavailable runtime with thread context", async () => {
    vi.stubGlobal("window", {});

    const result = await openFileInPreview({
      threadRef,
      filePath: "docs/report.pdf",
      httpBaseUrl: "https://environment.test",
      createAssetUrl: vi.fn(),
      openPreview: vi.fn(),
    });
    const error = result._tag === "Failure" ? Cause.squash(result.cause) : undefined;

    expect(error).toEqual(
      new BrowserPreviewUnavailableError({
        environmentId: "environment-1",
        threadId: "thread-1",
      }),
    );
    expect(error).toMatchObject({
      message: "The integrated browser is unavailable in this runtime.",
    });
  });

  it("reports invalid asset URLs with safe context and the exact parser cause", async () => {
    vi.stubGlobal("window", { desktopBridge: { preview: {} } });
    const parserCause = new TypeError("invalid URL");
    const InvalidUrl = vi.fn(function InvalidUrl() {
      throw parserCause;
    });
    vi.stubGlobal("URL", InvalidUrl);
    const openPreview = vi.fn();
    const httpBaseUrl = "not a URL";
    const relativeUrl = "/api/assets/signed-secret-token/docs/report.pdf";
    const expiresAt = Date.now();

    const result = await openFileInPreview({
      threadRef,
      filePath: "docs/report.pdf",
      httpBaseUrl,
      createAssetUrl: async () => AsyncResult.success({ relativeUrl, expiresAt }),
      openPreview,
    });
    const error = result._tag === "Failure" ? Cause.squash(result.cause) : undefined;

    expect(isBrowserPreviewAssetUrlInvalidError(error)).toBe(true);
    if (!isBrowserPreviewAssetUrlInvalidError(error)) {
      throw new Error("Expected BrowserPreviewAssetUrlInvalidError");
    }
    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
      filePath: "docs/report.pdf",
      httpBaseUrlLength: httpBaseUrl.length,
      relativeUrlLength: relativeUrl.length,
      expiresAt,
    });
    expect(error.cause).toBe(parserCause);
    expect(error.message).toBe("The environment returned an invalid asset URL.");
    expect(error).not.toHaveProperty("httpBaseUrl");
    expect(error).not.toHaveProperty("relativeUrl");
    expect(JSON.stringify(error)).not.toContain("signed-secret-token");
    expect(openPreview).not.toHaveBeenCalled();
  });
});

it("does not apply an older preview response after another caller starts a newer request", async () => {
  const firstSnapshot = snapshot("tab-1", "https://assets.test/first.png");
  const secondSnapshot = snapshot("tab-2", "https://assets.test/second.png");
  let resolveFirst!: (result: AtomCommandResult<PreviewSessionSnapshot, never>) => void;
  const openPreview: OpenPreviewMutation<never> = ({ input }) =>
    input.url === "https://assets.test/first.png"
      ? new Promise<AtomCommandResult<PreviewSessionSnapshot, never>>((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve(AsyncResult.success(secondSnapshot));

  const firstRequest = openUrlInPreview({
    threadRef,
    url: "https://assets.test/first.png",
    openPreview,
  });

  await openUrlInPreview({
    threadRef,
    url: "https://assets.test/second.png",
    openPreview,
  });
  resolveFirst(AsyncResult.success(firstSnapshot));
  await firstRequest;

  expect(readThreadPreviewState(threadRef).snapshot).toEqual(secondSnapshot);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
  ).toEqual([{ id: "browser:tab-2", kind: "preview", resourceId: "tab-2" }]);
});
