import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_NORMALIZED_STROKE_WIDTH,
  EMPTY_MARKUP_DOCUMENT,
  addElementCallout,
  addPointCallout,
  addRegionCallout,
  addStroke,
  annotationExportLayoutSize,
  annotationExportSize,
  aspectFit,
  clearMarkupDocument,
  commitMarkupDocument,
  createMarkupHistory,
  deleteMarkupObject,
  eraseMarkupObjectAtPoint,
  hitTestMarkupObject,
  makeStroke,
  nextSmallerExportSize,
  normalizedPoint,
  normalizedRectFromPoints,
  redoMarkupHistory,
  remainingAnnotationExportByteBudget,
  undoMarkupHistory,
  updateCalloutComment,
} from "./model";

describe("annotation markup geometry", () => {
  it("aspect-fits an image without distorting it", () => {
    expect(aspectFit({ width: 1_600, height: 900 }, { width: 1_000, height: 1_000 })).toEqual({
      x: 0,
      y: 218.75,
      width: 1_000,
      height: 562.5,
    });
    expect(normalizedPoint({ x: 500, y: 281.25 }, { width: 1_000, height: 562.5 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it("normalizes dragged regions in either direction and rejects taps", () => {
    expect(normalizedRectFromPoints({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.1 })).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.6000000000000001,
      height: 0.5,
    });
    expect(normalizedRectFromPoints({ x: 0.2, y: 0.2 }, { x: 0.202, y: 0.4 })).toBeNull();
  });

  it("downscales by both edge and pixel budgets without upscaling", () => {
    expect(annotationExportSize({ width: 4_000, height: 3_000 })).toEqual({
      width: 2_048,
      height: 1_536,
    });
    expect(
      annotationExportSize(
        { width: 4_000, height: 3_000 },
        { maxEdge: 10_000, maxPixels: 1_000_000 },
      ),
    ).toEqual({ width: 1_154, height: 866 });
    expect(annotationExportSize({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
    });
    expect(nextSmallerExportSize({ width: 2_048, height: 1_536 })).toEqual({
      width: 1_536,
      height: 1_152,
    });
    expect(nextSmallerExportSize({ width: 320, height: 240 })).toBeNull();
  });

  it("lays out export SVGs in logical points while preserving target pixels", () => {
    expect(annotationExportLayoutSize({ width: 2_048, height: 1_536 }, 2)).toEqual({
      width: 1_024,
      height: 768,
    });
    expect(annotationExportLayoutSize({ width: 1_170, height: 2_532 }, 3)).toEqual({
      width: 390,
      height: 844,
    });
    expect(annotationExportLayoutSize({ width: 640, height: 480 }, 0)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("shares a fixed persistence budget between the original and flattened PNG", () => {
    expect(remainingAnnotationExportByteBudget(7_500_000, 10_000_000)).toBe(2_500_000);
    expect(remainingAnnotationExportByteBudget(10_000_000, 10_000_000)).toBe(0);
    expect(remainingAnnotationExportByteBudget(12_000_000, 10_000_000)).toBe(0);
  });
});

describe("annotation markup document", () => {
  it("assigns stable visible callout numbers and keeps per-callout comments", () => {
    const first = addPointCallout(EMPTY_MARKUP_DOCUMENT, {
      id: "point-1",
      point: { x: 0.25, y: 0.5 },
      comment: "First",
    });
    const second = addRegionCallout(first, {
      id: "region-2",
      rect: { x: 0.5, y: 0.25, width: 0.25, height: 0.2 },
    });
    const updated = updateCalloutComment(second, "region-2", "Tighten this space");
    const afterDelete = deleteMarkupObject(updated, { kind: "callout", id: "point-1" });
    const third = addPointCallout(afterDelete, {
      id: "point-3",
      point: { x: 0.9, y: 0.9 },
    });

    expect(updated.callouts.map(({ number, comment }) => ({ number, comment }))).toEqual([
      { number: 1, comment: "First" },
      { number: 2, comment: "Tighten this space" },
    ]);
    expect(third.callouts.map((callout) => callout.number)).toEqual([2, 3]);
  });

  it("keeps regions inside normalized bounds at the bottom-right edge", () => {
    const document = addRegionCallout(EMPTY_MARKUP_DOCUMENT, {
      id: "edge",
      rect: { x: 1, y: 1, width: 0.25, height: 0.25 },
    });
    const rect = document.callouts[0]?.anchor;

    expect(rect?.kind).toBe("region");
    if (rect?.kind !== "region") return;
    expect(rect.rect.x + rect.rect.width).toBeLessThanOrEqual(1);
    expect(rect.rect.y + rect.rect.height).toBeLessThanOrEqual(1);
    expect(rect.rect.width).toBeGreaterThan(0);
    expect(rect.rect.height).toBeGreaterThan(0);
  });

  it("anchors numbered callouts to semantic preview elements", () => {
    const document = addElementCallout(EMPTY_MARKUP_DOCUMENT, {
      id: "callout-submit",
      targetId: "element-submit",
      rect: { x: 0.42, y: 0.18, width: 0.31, height: 0.12 },
      comment: "Make this the primary action",
    });

    expect(document.callouts).toEqual([
      {
        id: "callout-submit",
        number: 1,
        comment: "Make this the primary action",
        anchor: {
          kind: "element",
          targetId: "element-submit",
          rect: { x: 0.42, y: 0.18, width: 0.31, height: 0.12 },
        },
      },
    ]);
  });

  it("creates bounded editable strokes and hit-tests or erases whole objects", () => {
    const stroke = makeStroke({
      id: "stroke-1",
      color: "#f00",
      width: DEFAULT_NORMALIZED_STROKE_WIDTH,
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.5, y: 0.6 },
      ],
    });
    expect(stroke).not.toBeNull();
    expect(stroke?.bounds.x).toBeGreaterThanOrEqual(0);
    expect((stroke?.bounds.x ?? 0) + (stroke?.bounds.width ?? 0)).toBeLessThanOrEqual(1);

    const document = addPointCallout(addStroke(EMPTY_MARKUP_DOCUMENT, stroke!), {
      id: "point-1",
      point: { x: 0.8, y: 0.2 },
    });
    expect(hitTestMarkupObject(document, { x: 0.3, y: 0.4 })).toEqual({
      kind: "stroke",
      id: "stroke-1",
    });
    expect(hitTestMarkupObject(document, { x: 0.8, y: 0.2 })).toEqual({
      kind: "callout",
      id: "point-1",
    });
    expect(eraseMarkupObjectAtPoint(document, { x: 0.3, y: 0.4 }).strokes).toEqual([]);
  });

  it("hit-tests a single-point stroke across its rendered width", () => {
    const stroke = makeStroke({
      id: "dot-1",
      color: "#f00",
      width: 0.1,
      points: [{ x: 0.5, y: 0.5 }],
    });
    expect(stroke).not.toBeNull();
    const document = addStroke(EMPTY_MARKUP_DOCUMENT, stroke!);

    expect(hitTestMarkupObject(document, { x: 0.56, y: 0.5 }, 0.02)).toEqual({
      kind: "stroke",
      id: "dot-1",
    });
  });

  it("supports undo, redo, delete, and clear without mutating snapshots", () => {
    const initial = createMarkupHistory(EMPTY_MARKUP_DOCUMENT);
    const one = addPointCallout(initial.present, {
      id: "point-1",
      point: { x: 0.2, y: 0.3 },
    });
    const committed = commitMarkupDocument(initial, one);
    const undone = undoMarkupHistory(committed);
    const redone = redoMarkupHistory(undone);

    expect(undone.present).toBe(EMPTY_MARKUP_DOCUMENT);
    expect(redone.present).toBe(one);
    expect(committed.present.callouts).toHaveLength(1);
    expect(clearMarkupDocument(redone.present)).toBe(EMPTY_MARKUP_DOCUMENT);
  });
});
