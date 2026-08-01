import { expect, it } from "@effect/vitest";
import {
  PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES,
  PREVIEW_REVIEW_SNAPSHOT_MAX_PAGE_REVISION_LENGTH,
  PreviewReviewSnapshotMalformedError,
  PreviewReviewSnapshotTooLargeError,
  PreviewTabId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewReviewSnapshotInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { compactPreviewReviewSnapshot } from "./ReviewSnapshot.ts";

const request = {
  version: 1,
  threadId: ThreadId.make("thread-1"),
  tabId: PreviewTabId.make("tab-1"),
} as const satisfies PreviewReviewSnapshotInput;

const snapshot = {
  url: "http://localhost:5173",
  title: "T3",
  loading: false,
  visibleText: "Send",
  interactiveElements: [
    {
      tag: "button",
      role: "button",
      name: "Send",
      selector: "#send",
      x: -5,
      y: 10,
      width: 20,
      height: 30,
    },
    {
      tag: "button",
      role: "button",
      name: "Offscreen",
      selector: "#offscreen",
      x: 900,
      y: 10,
      width: 20,
      height: 30,
    },
  ],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAyAAAAJY",
    width: 800,
    height: 600,
  },
} as const satisfies PreviewAutomationSnapshot;

const compact = (value: PreviewAutomationSnapshot = snapshot) =>
  compactPreviewReviewSnapshot({
    request,
    snapshot: value,
    snapshotId: "snapshot-1",
    capturedAt: "2026-07-30T12:00:00.000Z",
    previewState: { serverEpoch: "server-1", revision: 7 },
  });

it.effect("compacts a legacy automation snapshot with deterministic fallbacks", () =>
  Effect.gen(function* () {
    const result = yield* compact();

    expect(result).toMatchObject({
      version: 1,
      snapshotId: "snapshot-1",
      pageRevision: "snapshot-1",
      serverEpoch: "server-1",
      previewRevision: 7,
      threadId: "thread-1",
      tabId: "tab-1",
      viewport: {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
      screenshot: { scale: 1 },
      elements: [
        {
          id: "element-1",
          rect: { x: 0, y: 10, width: 15, height: 30 },
        },
      ],
    });
  }),
);

it.effect("preserves host viewport, scale, and frame metadata", () =>
  Effect.gen(function* () {
    const result = yield* compact({
      ...snapshot,
      pageRevision: "page-8",
      capturedAt: "2026-07-30T11:59:59.000Z",
      viewport: {
        width: 400,
        height: 300,
        scrollX: 8,
        scrollY: 16,
        devicePixelRatio: 2,
      },
      screenshot: {
        ...snapshot.screenshot,
        scale: 2,
      },
    });

    expect(result.pageRevision).toBe("page-8");
    expect(result.capturedAt).toBe("2026-07-30T11:59:59.000Z");
    expect(result.viewport).toEqual({
      width: 400,
      height: 300,
      scrollX: 8,
      scrollY: 16,
      devicePixelRatio: 2,
    });
    expect(result.screenshot.scale).toBe(2);
  }),
);

it.effect("rejects malformed screenshot data", () =>
  Effect.gen(function* () {
    const error = yield* compact({
      ...snapshot,
      screenshot: { ...snapshot.screenshot, data: "not base64" },
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(PreviewReviewSnapshotMalformedError);
  }),
);

it.effect("rejects base64 that is not a matching PNG frame", () =>
  Effect.gen(function* () {
    const invalidSignature = yield* compact({
      ...snapshot,
      screenshot: {
        ...snapshot.screenshot,
        data: Buffer.from("this is not a png").toString("base64"),
      },
    }).pipe(Effect.flip);
    const mismatchedDimensions = yield* compact({
      ...snapshot,
      screenshot: { ...snapshot.screenshot, width: snapshot.screenshot.width + 1 },
    }).pipe(Effect.flip);

    expect(invalidSignature).toBeInstanceOf(PreviewReviewSnapshotMalformedError);
    expect(mismatchedDimensions).toBeInstanceOf(PreviewReviewSnapshotMalformedError);
  }),
);

it.effect("rejects a screenshot whose aspect ratio does not match its viewport", () =>
  Effect.gen(function* () {
    const error = yield* compact({
      ...snapshot,
      viewport: {
        width: 400,
        height: 280,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 2,
      },
      screenshot: { ...snapshot.screenshot, scale: 2 },
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(PreviewReviewSnapshotMalformedError);
  }),
);

it.effect("rejects an unbounded host page revision before returning it", () =>
  Effect.gen(function* () {
    const error = yield* compact({
      ...snapshot,
      pageRevision: "r".repeat(PREVIEW_REVIEW_SNAPSHOT_MAX_PAGE_REVISION_LENGTH + 1),
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(PreviewReviewSnapshotMalformedError);
  }),
);

it.effect("rejects review images above the shared upload limit", () =>
  Effect.gen(function* () {
    const error = yield* compact({
      ...snapshot,
      screenshot: {
        ...snapshot.screenshot,
        data: Buffer.alloc(PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES + 1).toString("base64"),
      },
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(PreviewReviewSnapshotTooLargeError);
    if (error._tag === "PreviewReviewSnapshotTooLargeError") {
      expect(error.maximumBytes).toBe(PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES);
    }
  }),
);
