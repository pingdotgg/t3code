import {
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";

import { openPreviewSession } from "./openPreviewSession";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  ensureClientSettingsHydrated: () => Promise.resolve(),
  useSettings: (selector: (value: Record<string, unknown>) => unknown) =>
    selector(settings.current),
}));

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

const defaultSettings = {
  browserDefaultViewport: FILL_PREVIEW_VIEWPORT,
  browserDefaultZoomFactor: 1,
  browserDefaultAppearance: "system",
  browserAutoShowFloatingPreview: true,
  browserProfiles: [],
  browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
};

beforeEach(() => {
  resetPreviewStateForTests();
  settings.current = defaultSettings;
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

  it("uses the configured profile and viewport for a newly opened tab", async () => {
    const configuredViewport = { _tag: "freeform", width: 1440, height: 900 } as const;
    settings.current = {
      ...defaultSettings,
      browserDefaultViewport: configuredViewport,
      browserProfiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
      browserDefaultProfileId: "profile-work",
    };
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));
    const sequence: string[] = [];

    await openPreviewSession({
      openPreview: ({ input }) => {
        sequence.push("open");
        return open(input);
      },
      threadRef,
      url: "t3.chat",
      beforeOpen: async (profileId) => {
        sequence.push(`prepare:${profileId}`);
      },
    });

    expect(sequence).toEqual(["prepare:profile-work", "open"]);
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "t3.chat",
      viewport: configuredViewport,
      profileId: "profile-work",
    });
  });

  it("preserves the existing tab profile instead of switching to the configured default", async () => {
    settings.current = {
      ...defaultSettings,
      browserProfiles: [
        { id: "profile-existing", name: "Existing", kind: "persistent" },
        { id: "profile-default", name: "Default", kind: "persistent" },
      ],
      browserDefaultProfileId: "profile-default",
    };
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));
    const preparedProfiles: string[] = [];

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      url: "t3.chat",
      profileId: "profile-existing",
      beforeOpen: async (profileId) => {
        preparedProfiles.push(profileId);
      },
    });

    expect(preparedProfiles).toEqual(["profile-existing"]);
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "t3.chat",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-existing",
    });
  });

  it("opens a distinct tab for a delegated child using the same configured profile", async () => {
    settings.current = {
      ...defaultSettings,
      browserProfiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
      browserDefaultProfileId: "profile-work",
    };
    const childThreadRef = {
      ...threadRef,
      threadId: "thread-child" as ScopedThreadRef["threadId"],
    };
    const open = vi.fn(async (input: PreviewOpenInput) =>
      AsyncResult.success({
        ...snapshot,
        threadId: input.threadId,
        tabId: input.threadId === threadRef.threadId ? "tab-parent" : "tab-child",
      }),
    );

    await openPreviewSession({ openPreview: ({ input }) => open(input), threadRef });
    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef: childThreadRef,
    });

    expect(open).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-work",
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      threadId: "thread-child",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-work",
    });
    expect(readThreadPreviewState(threadRef).snapshot?.tabId).toBe("tab-parent");
    expect(readThreadPreviewState(childThreadRef).snapshot?.tabId).toBe("tab-child");
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
});
