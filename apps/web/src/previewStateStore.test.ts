import { scopeThreadRef } from "@t3tools/client-runtime";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { __testing, selectThreadPreviewState, usePreviewStateStore } from "./previewStateStore";

const environmentId = "env-1" as EnvironmentId;
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

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
  usePreviewStateStore.setState({ byThreadKey: {} });
});

describe("previewStateStore (single-tab)", () => {
  it("opened event seeds the snapshot and remembers the URL", () => {
    const snapshot = makeSnapshot();
    usePreviewStateStore.getState().applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("a second `opened` for a different tab replaces the rendered snapshot", () => {
    const a = makeSnapshot({ tabId: "tab_a" });
    const b = makeSnapshot({ tabId: "tab_b" });
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: a.tabId,
      createdAt: a.updatedAt,
      snapshot: a,
    });
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: b.tabId,
      createdAt: b.updatedAt,
      snapshot: b,
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.tabId).toBe(b.tabId);
  });

  it("navigated event updates the snapshot URL", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...snapshot,
        navStatus: { _tag: "Success", url: "http://localhost:5173/about", title: "About" },
      },
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.navStatus._tag).toBe("Success");
    if (state.snapshot?.navStatus._tag === "Success") {
      expect(state.snapshot.navStatus.url).toBe("http://localhost:5173/about");
    }
  });

  it("failed event flips the snapshot to LoadFailed when tabId matches", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:5173/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.navStatus._tag).toBe("LoadFailed");
  });

  it("failed event for a non-active tab is ignored", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:9999/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.navStatus._tag).toBe("Loading");
  });

  it("closed event clears snapshot but retains recently-seen URLs", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot).toBeNull();
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("closed event for a different tab is a no-op", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
  });

  it("desktopOverlay updates independently of snapshot", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    store.applyDesktopState(ref, snapshot.tabId, {
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      controller: "none",
    });
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
    expect(state.snapshot?.canGoBack).toBe(false);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    const store = usePreviewStateStore.getState();
    store.applyServerSnapshot(ref, first);
    store.applyServerSnapshot(ref, second);
    store.applyDesktopState(ref, first.tabId, {
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      controller: "none",
    });
    store.setActiveTab(ref, first.tabId);

    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("applyServerSnapshot null clears snapshot for a thread that had one", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerSnapshot(ref, snapshot);
    store.applyServerSnapshot(ref, null);
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.snapshot).toBeNull();
  });

  it("rememberUrl dedupes and caps at limit", () => {
    const store = usePreviewStateStore.getState();
    for (let i = 0; i < __testing.RECENT_URL_LIMIT + 5; i += 1) {
      store.rememberUrl(ref, `http://localhost:${5000 + i}/`);
    }
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state.recentlySeenUrls.length).toBeLessThanOrEqual(__testing.RECENT_URL_LIMIT);
    expect(state.recentlySeenUrls[0]).toBe(
      `http://localhost:${5000 + __testing.RECENT_URL_LIMIT + 4}/`,
    );
  });

  it("removeThread strips the entry", () => {
    const snapshot = makeSnapshot();
    const store = usePreviewStateStore.getState();
    store.applyServerSnapshot(ref, snapshot);
    store.removeThread(ref);
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, ref);
    expect(state).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });
});
