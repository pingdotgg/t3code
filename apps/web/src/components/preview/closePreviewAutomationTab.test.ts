import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { closePreviewAutomationTab } from "./closePreviewAutomationTab";

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
  updatedAt: "2026-08-31T14:00:00.000Z",
};

beforeEach(resetPreviewStateForTests);

describe("closePreviewAutomationTab", () => {
  it("removes the server session before destroying the Electron runtime", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const calls: string[] = [];
    const closePreview = vi.fn(async () => {
      calls.push("server");
      return AsyncResult.success(undefined);
    });
    const closeRuntimeTab = vi.fn(async () => {
      calls.push("runtime");
    });

    const result = await closePreviewAutomationTab({
      closePreview,
      closeRuntimeTab,
      runtimeTabId: "runtime-tab-1",
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(result._tag).toBe("Success");
    expect(calls).toEqual(["server", "runtime"]);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    expect(closePreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
    });
    expect(closeRuntimeTab).toHaveBeenCalledWith("runtime-tab-1");
  });

  it("keeps the runtime alive and restores state when the server close fails", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const closeRuntimeTab = vi.fn(async () => undefined);

    const result = await closePreviewAutomationTab({
      closePreview: async () => AsyncResult.failure(Cause.fail(new Error("close failed"))),
      closeRuntimeTab,
      runtimeTabId: "runtime-tab-1",
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(result._tag).toBe("Failure");
    expect(closeRuntimeTab).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });
});
