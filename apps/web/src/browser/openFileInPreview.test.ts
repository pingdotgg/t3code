import type { PreviewOpenInput, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetPreviewStateForTests } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { openFileInPreview } from "./openFileInPreview";

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
  updatedAt: "2026-08-18T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: { preview: {} } });
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openFileInPreview", () => {
  it.each([
    ["design files", ".t3/designs/design-1.html", ".t3/designs/design-1.html"],
    ["ordinary HTML files", "report.html", null],
  ])("adds editor metadata only when reopening %s", async (_scenario, sourcePath, designPath) => {
    const openPreview = vi.fn(
      async (_request: {
        readonly environmentId: ScopedThreadRef["environmentId"];
        readonly input: PreviewOpenInput;
      }) => AsyncResult.success(snapshot),
    );

    await openFileInPreview({
      threadRef,
      filePath: `/workspace/${sourcePath}`,
      httpBaseUrl: "http://127.0.0.1:3773",
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "/api/assets/token/file.html",
          expiresAt: 1,
          sourcePath,
        }),
      openPreview,
    });

    const openedUrl = new URL(openPreview.mock.calls[0]?.[0].input.url ?? "");
    expect(openedUrl.searchParams.has("t3-design")).toBe(designPath !== null);
    expect(openedUrl.searchParams.get("t3-design-path")).toBe(designPath);
  });
});
