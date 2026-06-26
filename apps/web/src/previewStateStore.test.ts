import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  rememberPreviewUrl,
  removePreviewThread,
  resetPreviewStateForTests,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "./previewStateStore";

const environmentId = "env-1" as EnvironmentId;
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

const makeSnapshot = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  resetPreviewStateForTests();
});

describe("previewStateStore (single-tab)", () => {
  it("keeps independent state atoms for each thread", () => {
    expect(previewStateAtom(scopedThreadKey(ref))).toBe(previewStateAtom(scopedThreadKey(ref)));
    expect(previewStateAtom(scopedThreadKey(ref))).not.toBe(
      previewStateAtom(scopedThreadKey(otherRef)),
    );

    applyPreviewServerSnapshot(ref, makeSnapshot());
    expect(readThreadPreviewState(ref).snapshot?.tabId).toBe("tab_a");
    expect(readThreadPreviewState(otherRef)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });

  it("opened event seeds the snapshot and remembers the URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("a second `opened` for a different tab replaces the rendered snapshot", () => {
    const a = makeSnapshot({ tabId: "tab_a" });
    const b = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: a.tabId,
      createdAt: a.updatedAt,
      snapshot: a,
    });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: b.tabId,
      createdAt: b.updatedAt,
      snapshot: b,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(b.tabId);
  });

  it("navigated event updates the snapshot URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...snapshot,
        navStatus: { _tag: "Success", url: "http://localhost:5173/about", title: "About" },
      },
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Success");
    if (state.snapshot?.navStatus._tag === "Success") {
      expect(state.snapshot.navStatus.url).toBe("http://localhost:5173/about");
    }
  });

  it("resized event updates tab viewport without changing the active tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const background = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    applyPreviewServerEvent(ref, {
      type: "resized",
      threadId: "thread-1",
      tabId: background.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...background,
        viewport: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]?.viewport).toEqual({
      _tag: "preset",
      presetId: "pixel-8",
      width: 412,
      height: 915,
    });
  });

  it("failed event flips the snapshot to LoadFailed when tabId matches", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:5173/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("LoadFailed");
  });

  it("failed event for a non-active tab is ignored", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:9999/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Loading");
  });

  it("closed event clears snapshot but retains recently-seen URLs", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("optimistically removes a session before the server close event arrives", () => {
    const first = makeSnapshot({ tabId: "tab_a" });
    const second = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);

    beginPreviewSessionClose(ref, second.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId]);
    expect(state.activeTabId).toBe(first.tabId);
    expect(state.snapshot?.tabId).toBe(first.tabId);
  });

  it("treats a late server close event after optimistic removal as a no-op", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("does not resurrect an intentionally closed tab from a stale list snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerSnapshot(ref, snapshot);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("can restore a suppressed tab after a failed close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    cancelPreviewSessionClose(ref, snapshot, snapshot.tabId);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.snapshot).toEqual(snapshot);
  });

  it("closed event for a different tab is a no-op", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
  });

  it("desktopOverlay updates independently of snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewDesktopState(ref, snapshot.tabId, {
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      controller: "none",
    });
    const state = readThreadPreviewState(ref);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
    expect(state.snapshot?.canGoBack).toBe(false);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      controller: "none",
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("updates a background snapshot without changing the active tab", () => {
    const background = makeSnapshot({ tabId: "tab_a" });
    const active = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    const resized = {
      ...background,
      viewport: { _tag: "freeform" as const, width: 900, height: 700 },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    updatePreviewServerSnapshot(ref, resized);

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot?.tabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]).toEqual(resized);
  });

  it("reconciles an authoritative session list without focusing a background tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const stale = makeSnapshot({
      tabId: "tab_stale",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, stale);
    applyPreviewServerSnapshot(ref, active);
    applyPreviewDesktopState(ref, stale.tabId, {
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      controller: "none",
    });

    reconcilePreviewServerSessions(ref, [active]);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]).toBeUndefined();
  });

  it("clears stale sessions when an authoritative list is empty", () => {
    applyPreviewServerSnapshot(ref, makeSnapshot());

    reconcilePreviewServerSessions(ref, []);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.activeTabId).toBeNull();
    expect(state.snapshot).toBeNull();
  });

  it("applyServerSnapshot null clears snapshot for a thread that had one", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    applyPreviewServerSnapshot(ref, null);
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
  });

  it("does not replace a streamed snapshot with older SWR data", () => {
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/new", title: "New" },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/old", title: "Old" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "http://localhost:5173/new",
      title: "New",
    });
  });

  it("rememberUrl dedupes and caps at limit", () => {
    for (let i = 0; i < __testing.RECENT_URL_LIMIT + 5; i += 1) {
      rememberPreviewUrl(ref, `http://localhost:${5000 + i}/`);
    }
    const state = readThreadPreviewState(ref);
    expect(state.recentlySeenUrls.length).toBeLessThanOrEqual(__testing.RECENT_URL_LIMIT);
    expect(state.recentlySeenUrls[0]).toBe(
      `http://localhost:${5000 + __testing.RECENT_URL_LIMIT + 4}/`,
    );
  });

  it("removeThread strips the entry", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    removePreviewThread(ref);
    const state = readThreadPreviewState(ref);
    expect(state).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });
});
