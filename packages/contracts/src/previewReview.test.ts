import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PREVIEW_REVIEW_SNAPSHOT_MAX_ELEMENTS,
  PreviewAutomationReviewSnapshot,
  PreviewAutomationSnapshot,
  PreviewReviewSnapshot,
  PreviewReviewSnapshotInput,
} from "./previewAutomation.ts";

const decodeInput = Schema.decodeUnknownSync(PreviewReviewSnapshotInput);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewReviewSnapshot);
const decodeAutomationSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);
const decodeAutomationReviewSnapshot = Schema.decodeUnknownSync(PreviewAutomationReviewSnapshot);

const reviewSnapshot = {
  version: 1,
  snapshotId: "snapshot-1",
  pageRevision: "page-1",
  serverEpoch: "server-1",
  previewRevision: 4,
  threadId: "thread-1",
  tabId: "tab-1",
  capturedAt: "2026-07-30T12:00:00.000Z",
  url: "http://localhost:5173",
  title: "T3",
  loading: false,
  viewport: {
    width: 1_280,
    height: 800,
    scrollX: 0,
    scrollY: 120,
    devicePixelRatio: 2,
  },
  screenshot: {
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    width: 1_280,
    height: 800,
    scale: 1,
  },
  elements: [
    {
      id: "element-1",
      tag: "button",
      role: "button",
      name: "Send",
      selector: "#send",
      rect: { x: 12, y: 20, width: 100, height: 40 },
    },
  ],
} as const;

describe("preview review snapshot contracts", () => {
  it("requires a versioned exact thread and tab target", () => {
    expect(
      decodeInput({
        version: 1,
        threadId: "thread-1",
        tabId: "tab-1",
      }),
    ).toEqual({
      version: 1,
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(() => decodeInput({ version: 1, threadId: "thread-1" })).toThrow();
  });

  it("decodes the compact versioned review result", () => {
    expect(decodeSnapshot(reviewSnapshot)).toEqual(reviewSnapshot);
  });

  it("caps semantic elements at the desktop snapshot bound", () => {
    expect(() =>
      decodeSnapshot({
        ...reviewSnapshot,
        elements: Array.from({ length: PREVIEW_REVIEW_SNAPSHOT_MAX_ELEMENTS + 1 }, (_, index) => ({
          ...reviewSnapshot.elements[0],
          id: `element-${index}`,
        })),
      }),
    ).toThrow();
  });

  it("keeps viewport and image scale optional on mixed-version automation hosts", () => {
    const legacy = {
      url: "http://localhost:5173",
      title: "T3",
      loading: false,
      visibleText: "Send",
      interactiveElements: [],
      accessibilityTree: {},
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        width: 1_280,
        height: 800,
      },
    } as const;
    expect(decodeAutomationSnapshot(legacy)).toEqual(legacy);
    expect(
      decodeAutomationSnapshot({
        ...legacy,
        viewport: reviewSnapshot.viewport,
        screenshot: reviewSnapshot.screenshot,
      }),
    ).toMatchObject({
      viewport: reviewSnapshot.viewport,
      screenshot: { scale: 1 },
    });
    expect(decodeAutomationReviewSnapshot(legacy)).toEqual({
      url: legacy.url,
      title: legacy.title,
      loading: legacy.loading,
      interactiveElements: legacy.interactiveElements,
      screenshot: legacy.screenshot,
    });
  });
});
