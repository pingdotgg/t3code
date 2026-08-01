import {
  ThreadId,
  type PreviewEvent,
  type PreviewReviewSnapshot,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergePreviewSessionSnapshots,
  previewCaptureCanCommit,
  previewCaptureErrorMessage,
  previewEventRequiresSessionRefresh,
  previewLiveUrlForSelection,
  upsertPreviewSessionSnapshot,
} from "./previewPaneModel";

const threadId = ThreadId.make("thread-1");
const session = {
  threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Success",
    url: "http://localhost:5173/old",
    title: "Old",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-07-30T12:00:00.000Z",
} as const satisfies PreviewSessionSnapshot;

const snapshot = {
  version: 1,
  tabId: "tab-1",
  snapshotId: "snapshot-1",
  pageRevision: "page-1",
  serverEpoch: "epoch-1",
  previewRevision: 1,
  threadId,
  capturedAt: "2026-07-30T12:00:00.000Z",
  url: "http://localhost:5173/snapshot",
  title: "Snapshot",
  loading: false,
  viewport: {
    width: 1_000,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
  },
  screenshot: {
    mimeType: "image/png",
    data: "aGVsbG8=",
    width: 1_000,
    height: 800,
    scale: 1,
  },
  elements: [],
} as const satisfies PreviewReviewSnapshot;

function navigatedEvent(overrides: Partial<PreviewEvent> = {}): PreviewEvent {
  return {
    type: "navigated",
    threadId,
    tabId: "tab-1",
    createdAt: "2026-07-30T12:01:00.000Z",
    serverEpoch: "epoch-1",
    revision: 2,
    snapshot: {
      ...session,
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/current",
        title: "Current",
      },
    },
    ...overrides,
  } as PreviewEvent;
}

describe("mobile preview pane state", () => {
  it("keeps a newly-created optimistic tab until the server list includes it", () => {
    const idle = {
      ...session,
      tabId: "tab-2",
      navStatus: { _tag: "Idle" },
      updatedAt: "2026-07-30T12:01:00.000Z",
    } as const satisfies PreviewSessionSnapshot;

    expect(mergePreviewSessionSnapshots([session], [idle])).toEqual([session, idle]);
    expect(upsertPreviewSessionSnapshot([session], idle)).toEqual([session, idle]);
  });

  it("prefers a newer optimistic navigation over a stale server snapshot", () => {
    const navigated = {
      ...session,
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/new",
        title: "",
      },
      updatedAt: "2026-07-30T12:02:00.000Z",
    } as const satisfies PreviewSessionSnapshot;

    expect(mergePreviewSessionSnapshots([session], [navigated])).toEqual([navigated]);
    expect(upsertPreviewSessionSnapshot([session], navigated)).toEqual([navigated]);
  });

  it("turns an older server's unknown review RPC into upgrade guidance", () => {
    expect(
      previewCaptureErrorMessage(new Error("Unknown request tag: preview.reviewSnapshot")),
    ).toMatch(/updated T3 desktop and server/);
    expect(previewCaptureErrorMessage(null)).toBe(
      "The desktop preview could not capture a review snapshot.",
    );
  });

  it("ignores a capture that resolves after another tab became active", () => {
    expect(
      previewCaptureCanCommit({
        activeRequestId: 2,
        requestId: 1,
        selectedTabId: "tab-2",
        requestedTabId: "tab-1",
        threadId,
        snapshot,
      }),
    ).toBe(false);
    expect(
      previewCaptureCanCommit({
        activeRequestId: 2,
        requestId: 2,
        selectedTabId: "tab-1",
        requestedTabId: "tab-1",
        threadId,
        snapshot,
      }),
    ).toBe(true);
  });

  it("refreshes session membership and navigation state only for newer relevant events", () => {
    expect(
      previewEventRequiresSessionRefresh({
        event: navigatedEvent(),
        threadId,
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBe(true);
    expect(
      previewEventRequiresSessionRefresh({
        event: navigatedEvent(),
        threadId,
        serverEpoch: "epoch-1",
        revision: 2,
      }),
    ).toBe(false);
    expect(
      previewEventRequiresSessionRefresh({
        event: navigatedEvent({ threadId: ThreadId.make("thread-2") }),
        threadId,
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBe(false);
  });

  it("lets live mode follow a newer navigation event without waiting for another capture", () => {
    expect(
      previewLiveUrlForSelection({
        selectedTabId: "tab-1",
        selectedSession: session,
        snapshot,
        latestEvent: navigatedEvent(),
        threadId,
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBe("http://localhost:5173/current");
    expect(
      previewLiveUrlForSelection({
        selectedTabId: "tab-1",
        selectedSession: session,
        snapshot: null,
        latestEvent: null,
        threadId,
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBe("http://localhost:5173/old");
  });

  it("reconciles epoch changes without letting an old event override the new list", () => {
    const oldEpochEvent = navigatedEvent({
      serverEpoch: "epoch-1",
      revision: 99,
    });
    expect(
      previewEventRequiresSessionRefresh({
        event: oldEpochEvent,
        threadId,
        serverEpoch: "epoch-2",
        revision: 1,
      }),
    ).toBe(true);
    expect(
      previewLiveUrlForSelection({
        selectedTabId: "tab-1",
        selectedSession: session,
        snapshot: null,
        latestEvent: oldEpochEvent,
        threadId,
        serverEpoch: "epoch-2",
        revision: 1,
      }),
    ).toBe("http://localhost:5173/old");
  });

  it("lets an optimistic navigation supersede the new tab's newer Idle event", () => {
    const optimistic = {
      ...session,
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/from-ipad",
        title: "",
      },
      updatedAt: "2026-07-30T12:02:00.000Z",
    } as const satisfies PreviewSessionSnapshot;
    const opened = {
      type: "opened",
      threadId,
      tabId: "tab-1",
      createdAt: "2026-07-30T12:01:00.000Z",
      serverEpoch: "epoch-1",
      revision: 2,
      snapshot: {
        ...session,
        navStatus: { _tag: "Idle" },
        updatedAt: "2026-07-30T12:01:00.000Z",
      },
    } as const satisfies PreviewEvent;

    expect(
      previewLiveUrlForSelection({
        selectedTabId: "tab-1",
        selectedSession: optimistic,
        snapshot: null,
        latestEvent: opened,
        threadId,
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBe("http://localhost:5173/from-ipad");
  });

  it("removes a closed selected tab from the live target before list reconciliation", () => {
    const closed = {
      type: "closed",
      threadId,
      tabId: "tab-1",
      createdAt: "2026-07-30T12:02:00.000Z",
      serverEpoch: "epoch-1",
      revision: 3,
    } as const satisfies PreviewEvent;
    expect(
      previewLiveUrlForSelection({
        selectedTabId: "tab-1",
        selectedSession: session,
        snapshot,
        latestEvent: closed,
        threadId,
        serverEpoch: "epoch-1",
        revision: 2,
      }),
    ).toBeNull();
  });
});
