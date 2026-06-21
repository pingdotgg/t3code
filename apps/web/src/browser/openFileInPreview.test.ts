import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it } from "vite-plus/test";

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { type OpenPreviewMutation, openUrlInPreview } from "./openFileInPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
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
