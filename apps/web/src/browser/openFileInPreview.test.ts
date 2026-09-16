import type { PreviewOpenInput, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

import { threadDesigns } from "~/components/preview/threadDesigns";
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
  it.each(["asset", "preview"])(
    "does not present a file canceled during %s resolution",
    async (stage) => {
      const controller = new AbortController();
      useRightPanelStore.getState().openDesign(threadRef, "newer-design");
      const openPreview = vi.fn(async () => {
        if (stage === "preview") controller.abort();
        return AsyncResult.success(snapshot);
      });
      await openFileInPreview({
        threadRef,
        signal: controller.signal,
        filePath: "/workspace/.t3/designs/old.html",
        workspaceRoot: "/workspace",
        httpBaseUrl: "http://127.0.0.1:3773",
        createAssetUrl: async () => {
          if (stage === "asset") controller.abort();
          return AsyncResult.success({
            relativeUrl: "/api/assets/old/file.html",
            expiresAt: 1,
            sourcePath: ".t3/designs/old.html",
          });
        },
        openPreview,
      });
      expect(Object.values(useRightPanelStore.getState().byThreadKey)[0]?.surfaces).toEqual([
        { id: "design", kind: "design", resourceId: "newer-design" },
      ]);
      if (stage === "asset") expect(openPreview).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["design files", ".t3/designs/design-1.html", ".t3/designs/design-1.html"],
    ["web design files", ".t3/designs/design-1.html", ".t3/designs/design-1.html"],
    ["ordinary HTML files", "report.html", null],
  ])("adds editor metadata only when reopening %s", async (_scenario, sourcePath, designPath) => {
    if (_scenario === "web design files") vi.stubGlobal("window", {});
    const openPreview = vi.fn(
      async (request: {
        readonly environmentId: ScopedThreadRef["environmentId"];
        readonly input: PreviewOpenInput;
      }) =>
        AsyncResult.success({
          ...snapshot,
          navStatus: { _tag: "Loading" as const, url: request.input.url!, title: "" },
        }),
    );

    await openFileInPreview({
      threadRef,
      filePath: `/workspace/${sourcePath}`,
      workspaceRoot: "/workspace",
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
    if (designPath) {
      const designs = threadDesigns(
        readThreadPreviewState(threadRef).sessions,
        "http://127.0.0.1:3773",
      );
      expect(designs.map((design) => design.path)).toEqual([designPath]);
      useRightPanelStore.getState().reconcileBrowserSurfaces(
        threadRef,
        [],
        designs.map((design) => design.tabId),
      );
    }
    expect(Object.values(useRightPanelStore.getState().byThreadKey)[0]?.activeSurfaceId).toBe(
      designPath ? "design" : "browser:tab-1",
    );
  });
});
