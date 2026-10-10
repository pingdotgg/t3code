import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as browserDefaults from "~/browser/browserDefaults";
import { BrowserSettingsReadError, openUrlInPreview } from "~/browser/openFileInPreview";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "~/previewStateStore";

import { openPreviewSession } from "./openPreviewSession";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Loading",
    url: "https://t3.chat/",
    title: "",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-11T23:00:00.000Z",
};

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openPreviewSession", () => {
  it("creates an idle tab without recording a recently visited URL", async () => {
    const idleSnapshot: PreviewSessionSnapshot = {
      ...snapshot,
      tabId: "tab-blank",
      navStatus: { _tag: "Idle" },
    };
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(idleSnapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(idleSnapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it("applies the RPC response without waiting for a preview event", async () => {
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      url: "t3.chat",
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "t3.chat",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual(["https://t3.chat/"]);
  });

  it("opens a server tab at the default appearance", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserDefaultAppearance: "dark" });
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      runtime: "server",
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
      runtime: "server",
      colorScheme: "dark",
    });
  });

  it("leaves a desktop tab's appearance to the desktop", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserDefaultAppearance: "dark" });
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      runtime: "desktop",
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
  });

  it("returns failures without mutating preview state", async () => {
    const failure = new Error("preview unavailable");

    const result = await openPreviewSession({
      openPreview: async () => AsyncResult.failure(Cause.fail(failure)),
      threadRef,
      url: "t3.chat",
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it.each(["session", "link"] as const)(
    "does not open a %s with unread settings and uses the saved profile on retry",
    async (entryPoint) => {
      const failure = new Error("Settings read failed");
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(failure);
      const viewport = { _tag: "freeform", width: 1280, height: 720 } as const;
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultViewport: viewport,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const input = { openPreview, threadRef, url: "https://t3.chat/" };
      const open = entryPoint === "session" ? openPreviewSession : openUrlInPreview;

      const result = await open(input);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toBeInstanceOf(BrowserSettingsReadError);
        expect(Cause.squash(result.cause)).toMatchObject({ cause: failure });
      }
      expect(openPreview).not.toHaveBeenCalled();
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);

      await expect(open(input)).resolves.toMatchObject({ _tag: "Success" });
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: input.url,
          viewport,
          profileId: "work",
        },
      });
    },
  );
});

describe("openUrlInPreview from a link", () => {
  it("opens under the source tab's profile instead of the default", async () => {
    const openPreview = vi.fn(async (_arg: { input: PreviewOpenInput }) =>
      AsyncResult.success(snapshot),
    );

    await openUrlInPreview({ openPreview, threadRef, url: "https://t3.chat/", profileId: "work" });

    expect(openPreview.mock.calls[0]?.[0].input.profileId).toBe("work");
  });

  it("keeps the current tab active for a background open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    const state = readThreadPreviewState(threadRef);
    expect(state.activeTabId).toBe("tab-current");
    expect(Object.keys(state.sessions).toSorted()).toEqual(["tab-1", "tab-current"]);
  });

  it("keeps a tab the user picked while a background open was in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        // The server activates the new tab, then the user selects another one
        // before the open resolves.
        applyPreviewServerSnapshot(threadRef, snapshot);
        setActivePreviewTab(threadRef, "tab-other");
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-other");
  });

  it("keeps the new tab when the user picks it while a background open is in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        // The server activates the new tab, then the user clicks that same tab.
        applyPreviewServerSnapshot(threadRef, snapshot);
        useRightPanelStore.getState().openBrowser(threadRef, snapshot.tabId);
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
  });

  it("activates the new tab for a foreground open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
  });
});
