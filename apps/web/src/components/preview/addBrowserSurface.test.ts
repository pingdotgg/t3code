import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  rememberPreviewUrl,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";

import { addBrowserSurface, openRecentBrowserSurface } from "./addBrowserSurface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("addBrowserSurface", () => {
  it("opens under the requested profile", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    await addBrowserSurface({
      threadRef,
      openPreview: ({ input }) => openPreview(input),
      profileId: "profile-work",
    });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-work",
    });
  });

  it("creates another preview session when a browser tab is already active", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-1", "browser:tab-2"]);
  });
});

describe("openRecentBrowserSurface", () => {
  it("opens only one tab for overlapping shortcut invocations", async () => {
    let tabNumber = 0;
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot(`tab-${++tabNumber}`)));
    await Promise.all([
      openRecentBrowserSurface({ threadRef, openPreview }),
      openRecentBrowserSurface({ threadRef, openPreview }),
    ]);
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1"]);
  });

  it("allows another shortcut attempt after opening fails", async () => {
    const openPreview = vi.fn(async () =>
      AsyncResult.failure<PreviewSessionSnapshot, Error>(Cause.fail(new Error("Open failed"))),
    );
    await openRecentBrowserSurface({ threadRef, openPreview });
    await openRecentBrowserSurface({ threadRef, openPreview });
    expect(openPreview).toHaveBeenCalledTimes(2);
  });

  it("opens a blank browser when the thread has no URL", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot("tab-1")));
    await openRecentBrowserSurface({ threadRef, openPreview });
    expect(openPreview.mock.calls).toHaveLength(1);
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it("restores the most recent URL without borrowing another thread's history", async () => {
    rememberPreviewUrl(threadRef, "https://example.com/old");
    rememberPreviewUrl(threadRef, "https://example.com/recent");
    rememberPreviewUrl(
      { ...threadRef, threadId: "other" as ScopedThreadRef["threadId"] },
      "https://other.com/",
    );
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-2")),
    );
    await openRecentBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });
    expect(openPreview).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/recent", threadId: threadRef.threadId }),
    );
  });

  it("reopens the tab with the most recent URL and never toggles it closed", async () => {
    const existing = {
      ...snapshot("tab-1"),
      navStatus: { _tag: "Success" as const, url: "https://example.com/", title: "Example" },
    };
    applyPreviewServerSnapshot(threadRef, existing);
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot("tab-2")));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await openRecentBrowserSurface({ threadRef, openPreview });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
          .activeSurfaceId,
      ).toBe("browser:tab-1");
    }
    expect(openPreview).not.toHaveBeenCalled();
  });
});
