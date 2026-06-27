import type {
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { closePreviewSession } from "./closePreviewSession";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Success",
    url: "http://localhost:3000/",
    title: "Local app",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:00.000Z",
};

beforeEach(resetPreviewStateForTests);

describe("closePreviewSession", () => {
  it("suppresses stale server snapshots while the close is in flight", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    let finishClose: (() => void) | undefined;
    const closePreview = vi.fn(
      (_input: PreviewCloseInput) =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
    );

    const closing = closePreviewSession({
      closePreview: ({ input }) => closePreview(input),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    applyPreviewServerSnapshot(threadRef, snapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});

    finishClose?.();
    await closing;
    expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
  });

  it("restores the last snapshot when the server close fails", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);

    const result = await closePreviewSession({
      closePreview: async () => AsyncResult.failure(Cause.fail(new Error("close failed"))),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });
});
