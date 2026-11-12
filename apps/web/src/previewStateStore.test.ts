import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "./previewStateStore";
import { appAtomRegistry } from "./rpc/atomRegistry";

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

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const serverEpoch = "server-a";
let nextServerRevision = 0;
const applyPreviewServerEvent = (eventRef: typeof ref, event: PreviewEventDraft): void => {
  nextServerRevision += 1;
  applyPreviewServerEventImpl(eventRef, {
    ...event,
    serverEpoch,
    revision: nextServerRevision,
  } as PreviewEvent);
};

beforeEach(() => {
  nextServerRevision = 0;
  resetPreviewStateForTests();
});

describe("previewStateStore (single-tab)", () => {
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

  it("does not publish duplicate desktop browser state", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    const overlay = {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "none" as const,
      favicon: {
        dataUrl: "data:image/png;base64,AA==",
        pageUrl: "https://example.com",
        capturedAt: 1,
      },
    };
    let updateCount = 0;
    const unsubscribe = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(ref)), () => {
      updateCount += 1;
    });

    applyPreviewDesktopState(ref, snapshot.tabId, overlay);
    applyPreviewDesktopState(ref, snapshot.tabId, { ...overlay, favicon: { ...overlay.favicon } });
    unsubscribe();

    expect(updateCount).toBe(1);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
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
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });

    reconcilePreviewServerSessions(ref, { sessions: [active], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]).toBeUndefined();
  });

  it("keeps the state object when a refetched list changes nothing", () => {
    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    const loaded = readThreadPreviewState(ref);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    expect(readThreadPreviewState(ref)).toBe(loaded);

    const snapshot = makeSnapshot();
    reconcilePreviewServerSessions(ref, { sessions: [snapshot], serverEpoch, revision: 2 });
    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("ignores a list response older than the latest server event", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 0 });

    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(readThreadPreviewState(ref).listLoaded).toBe(false);

    const olderTab = makeSnapshot({ tabId: "tab_before_event" });
    reconcilePreviewServerSessions(ref, {
      sessions: [olderTab, snapshot],
      serverEpoch,
      revision: 2,
    });
    expect(readThreadPreviewState(ref).listLoaded).toBe(true);
    expect(readThreadPreviewState(ref).sessions).toEqual({
      [olderTab.tabId]: olderTab,
      [snapshot.tabId]: snapshot,
    });
  });

  it("does not resurrect a tab from an event older than its close", () => {
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

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
  });

  it("accepts a lower revision from a newly restarted server", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(0);
  });

  it("does not carry raw-tab state across a server restart", () => {
    const previous = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://old.example", title: "Old" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: previous.tabId,
      createdAt: previous.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: previous,
    });
    beginPreviewSessionClose(ref, previous.tabId);
    applyPreviewDesktopState(ref, previous.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    const restarted = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://new.example", title: "New" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    reconcilePreviewServerSessions(ref, {
      sessions: [restarted],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions[restarted.tabId]).toEqual(restarted);
    expect(state.suppressedTabIds).toEqual(new Set());
    expect(state.desktopByTabId).toEqual({});
    expect(state.desktopOverlay).toBeNull();
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
});
