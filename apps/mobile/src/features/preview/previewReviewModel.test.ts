import { describe, expect, it } from "vite-plus/test";

import { ThreadId, type PreviewAnnotationPayload } from "@t3tools/contracts";
import {
  createPreviewSnapshotMarkupSeed,
  normalizePreviewElementRect,
  normalizedRectForSemanticElement,
  previewSnapshotIsStale,
  previewSnapshotSemanticElements,
  selectedSemanticElements,
  semanticElementAtPoint,
  type MobilePreviewReviewSnapshot,
} from "./previewReviewModel";

const snapshot = {
  version: 1,
  tabId: "tab-1",
  snapshotId: "snapshot-1",
  pageRevision: "page-7",
  serverEpoch: "server-epoch-1",
  previewRevision: 7,
  threadId: ThreadId.make("thread-1"),
  capturedAt: "2026-07-30T12:00:00.000Z",
  url: "http://localhost:5173/checkout",
  title: "Checkout",
  loading: false,
  viewport: {
    width: 1_000,
    height: 800,
    scrollX: 0,
    scrollY: 320,
    devicePixelRatio: 2,
  },
  screenshot: {
    mimeType: "image/png",
    data: "aGVsbG8=",
    width: 1_280,
    height: 1_024,
    scale: 1.28,
  },
  elements: [
    {
      id: "element-parent",
      tag: "section",
      role: "region",
      name: "Payment",
      selector: "#payment",
      rect: { x: 100, y: 80, width: 500, height: 300 },
    },
    {
      id: "element-button",
      tag: "button",
      role: "button",
      name: 'Pay "now"',
      selector: "button.submit",
      rect: { x: 420, y: 180, width: 160, height: 64 },
    },
    {
      id: "offscreen",
      tag: "button",
      role: "button",
      name: "Hidden",
      selector: "button.hidden",
      rect: { x: 1_100, y: 10, width: 100, height: 40 },
    },
  ],
} as const satisfies MobilePreviewReviewSnapshot;

describe("preview review model", () => {
  it("creates a preview-backed markup attachment with a stable page revision", () => {
    const seed = createPreviewSnapshotMarkupSeed({
      snapshot,
      attachmentId: "attachment-1",
      annotationId: "annotation-1",
    });
    expect(seed.attachment.previewUri).toMatch(/^data:image\/png;base64,/);
    expect(seed.attachment.markup?.annotation).toMatchObject({
      pageUrl: snapshot.url,
      pageTitle: snapshot.title,
      source: { kind: "preview", url: snapshot.url, title: snapshot.title },
      screenshot: {
        width: 1_280,
        height: 1_024,
        scale: 1.28,
        pageRevision: "page-7",
        cropRect: { x: 0, y: 0, width: 1_000, height: 800 },
      },
    });
    expect(seed.semanticElements.map((element) => element.id)).toEqual([
      "element-parent",
      "element-button",
    ]);
    expect(seed.semanticElements[1]?.element.htmlPreview).toBe(
      '<button role="button" aria-label="Pay &quot;now&quot;">',
    );
  });

  it("clips partially visible rectangles and rejects offscreen rectangles", () => {
    expect(
      normalizePreviewElementRect({ x: -50, y: 700, width: 200, height: 200 }, snapshot.viewport),
    ).toEqual({ x: 0, y: 0.875, width: 0.15, height: 0.125 });
    expect(
      normalizePreviewElementRect({ x: 1_100, y: 10, width: 100, height: 40 }, snapshot.viewport),
    ).toBeNull();
  });

  it("selects the smallest semantic element under a point", () => {
    const annotation = createPreviewSnapshotMarkupSeed({
      snapshot,
      attachmentId: "attachment-1",
      annotationId: "annotation-1",
    }).attachment.markup!.annotation;
    const elements = previewSnapshotSemanticElements(snapshot).map((target) => ({
      target,
      rect: normalizedRectForSemanticElement(target, annotation)!,
    }));
    expect(
      semanticElementAtPoint({
        point: { x: 0.5, y: 0.25 },
        elements,
      })?.target.id,
    ).toBe("element-button");
  });

  it("keeps only elements referenced by element callouts in agent context", () => {
    const candidates = previewSnapshotSemanticElements(snapshot);
    const base = createPreviewSnapshotMarkupSeed({
      snapshot,
      attachmentId: "attachment-1",
      annotationId: "annotation-1",
    }).attachment.markup!.annotation;
    const annotation: PreviewAnnotationPayload = {
      ...base,
      callouts: [
        {
          id: "callout-1",
          number: 1,
          comment: "Make this primary",
          anchor: {
            kind: "element",
            targetId: "element-button",
            rect: { x: 0.42, y: 0.225, width: 0.16, height: 0.08 },
          },
        },
      ],
    };
    expect(selectedSemanticElements({ annotation, candidates }).map((target) => target.id)).toEqual(
      ["element-button"],
    );
  });

  it("marks matching-tab snapshots stale after a revision or server restart", () => {
    const baseEvent = {
      type: "navigated",
      threadId: snapshot.threadId,
      tabId: snapshot.tabId,
      createdAt: "2026-07-30T12:01:00.000Z",
      serverEpoch: snapshot.serverEpoch,
      revision: snapshot.previewRevision,
      snapshot: {
        tabId: snapshot.tabId,
        threadId: snapshot.threadId,
        navStatus: {
          _tag: "Success",
          url: snapshot.url,
          title: snapshot.title,
        },
        canGoBack: false,
        canGoForward: false,
        viewport: { _tag: "freeform", width: 1_000, height: 800 },
        updatedAt: "2026-07-30T12:01:00.000Z",
      },
    } as const;

    expect(previewSnapshotIsStale(snapshot, baseEvent)).toBe(false);
    expect(
      previewSnapshotIsStale(snapshot, {
        ...baseEvent,
        revision: snapshot.previewRevision + 1,
      }),
    ).toBe(true);
    expect(
      previewSnapshotIsStale(snapshot, {
        ...baseEvent,
        serverEpoch: "server-epoch-2",
      }),
    ).toBe(true);
    expect(
      previewSnapshotIsStale(snapshot, {
        ...baseEvent,
        tabId: "tab-2",
        revision: snapshot.previewRevision + 1,
      }),
    ).toBe(false);
    expect(
      previewSnapshotIsStale(snapshot, {
        ...baseEvent,
        threadId: ThreadId.make("thread-2"),
        tabId: "tab-2",
        serverEpoch: "server-epoch-2",
      }),
    ).toBe(true);
  });
});
