import type {
  PreviewAnnotationCallout,
  PreviewAnnotationEditableStrokeV1,
  PreviewAnnotationNormalizedPoint,
  PreviewAnnotationNormalizedRect,
} from "@t3tools/contracts";

export type MarkupTool = "select" | "element" | "point" | "region" | "pen" | "erase";

export interface MarkupDocument {
  readonly callouts: ReadonlyArray<PreviewAnnotationCallout>;
  readonly strokes: ReadonlyArray<PreviewAnnotationEditableStrokeV1>;
}

export interface MarkupHistory {
  readonly past: ReadonlyArray<MarkupDocument>;
  readonly present: MarkupDocument;
  readonly future: ReadonlyArray<MarkupDocument>;
}

export type MarkupSelection =
  | { readonly kind: "callout"; readonly id: string }
  | { readonly kind: "stroke"; readonly id: string };

export interface MarkupSize {
  readonly width: number;
  readonly height: number;
}

export interface AspectFit extends MarkupSize {
  readonly x: number;
  readonly y: number;
}

export const EMPTY_MARKUP_DOCUMENT: MarkupDocument = {
  callouts: [],
  strokes: [],
};

export const DEFAULT_STROKE_COLOR = "#ff3b30";
export const DEFAULT_NORMALIZED_STROKE_WIDTH = 0.006;
export const MAX_ANNOTATION_EXPORT_EDGE = 2_048;
export const MAX_ANNOTATION_EXPORT_PIXELS = 4_000_000;
export const MIN_ANNOTATION_EXPORT_EDGE = 320;

const MAX_HISTORY_ENTRIES = 100;
const MIN_NORMALIZED_REGION_SIZE = 0.006;
const MIN_NORMALIZED_DISTANCE = 0.000_001;

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizedPoint(
  point: { readonly x: number; readonly y: number },
  size: MarkupSize,
): PreviewAnnotationNormalizedPoint {
  if (size.width <= 0 || size.height <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: clampNormalized(point.x / size.width),
    y: clampNormalized(point.y / size.height),
  };
}

export function aspectFit(image: MarkupSize, container: MarkupSize): AspectFit {
  if (image.width <= 0 || image.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

export function normalizedRectFromPoints(
  start: PreviewAnnotationNormalizedPoint,
  end: PreviewAnnotationNormalizedPoint,
): PreviewAnnotationNormalizedRect | null {
  const x = clampNormalized(Math.min(start.x, end.x));
  const y = clampNormalized(Math.min(start.y, end.y));
  const right = clampNormalized(Math.max(start.x, end.x));
  const bottom = clampNormalized(Math.max(start.y, end.y));
  const width = right - x;
  const height = bottom - y;

  if (width < MIN_NORMALIZED_REGION_SIZE || height < MIN_NORMALIZED_REGION_SIZE) {
    return null;
  }

  return { x, y, width, height };
}

function nextCalloutNumber(document: MarkupDocument): number {
  return document.callouts.reduce((maximum, callout) => Math.max(maximum, callout.number), 0) + 1;
}

export function addPointCallout(
  document: MarkupDocument,
  input: {
    readonly id: string;
    readonly point: PreviewAnnotationNormalizedPoint;
    readonly comment?: string;
  },
): MarkupDocument {
  return {
    ...document,
    callouts: [
      ...document.callouts,
      {
        id: input.id,
        number: nextCalloutNumber(document),
        comment: input.comment ?? "",
        anchor: {
          kind: "point",
          point: {
            x: clampNormalized(input.point.x),
            y: clampNormalized(input.point.y),
          },
        },
      },
    ],
  };
}

export function addRegionCallout(
  document: MarkupDocument,
  input: {
    readonly id: string;
    readonly rect: PreviewAnnotationNormalizedRect;
    readonly comment?: string;
  },
): MarkupDocument {
  const rect = boundedNormalizedRect(input.rect);

  return {
    ...document,
    callouts: [
      ...document.callouts,
      {
        id: input.id,
        number: nextCalloutNumber(document),
        comment: input.comment ?? "",
        anchor: {
          kind: "region",
          rect,
        },
      },
    ],
  };
}

function boundedNormalizedRect(
  input: PreviewAnnotationNormalizedRect,
): PreviewAnnotationNormalizedRect {
  const x = Math.min(clampNormalized(input.x), 1 - MIN_NORMALIZED_DISTANCE);
  const y = Math.min(clampNormalized(input.y), 1 - MIN_NORMALIZED_DISTANCE);
  const width = Math.max(MIN_NORMALIZED_DISTANCE, Math.min(clampNormalized(input.width), 1 - x));
  const height = Math.max(MIN_NORMALIZED_DISTANCE, Math.min(clampNormalized(input.height), 1 - y));
  return { x, y, width, height };
}

export function addElementCallout(
  document: MarkupDocument,
  input: {
    readonly id: string;
    readonly targetId: string;
    readonly rect: PreviewAnnotationNormalizedRect;
    readonly comment?: string;
  },
): MarkupDocument {
  const rect = boundedNormalizedRect(input.rect);
  return {
    ...document,
    callouts: [
      ...document.callouts,
      {
        id: input.id,
        number: nextCalloutNumber(document),
        comment: input.comment ?? "",
        anchor: {
          kind: "element",
          targetId: input.targetId,
          rect,
        },
      },
    ],
  };
}

export function updateCalloutComment(
  document: MarkupDocument,
  calloutId: string,
  comment: string,
): MarkupDocument {
  const calloutIndex = document.callouts.findIndex((callout) => callout.id === calloutId);
  if (calloutIndex < 0 || document.callouts[calloutIndex]?.comment === comment) {
    return document;
  }

  return {
    ...document,
    callouts: document.callouts.map((callout) =>
      callout.id === calloutId ? { ...callout, comment } : callout,
    ),
  };
}

function expandedPositiveRange(
  minimum: number,
  maximum: number,
  padding: number,
): { readonly start: number; readonly length: number } {
  let start = clampNormalized(minimum - padding);
  let end = clampNormalized(maximum + padding);
  if (end - start >= MIN_NORMALIZED_DISTANCE) {
    return { start, length: end - start };
  }

  if (start >= 1) {
    start = 1 - MIN_NORMALIZED_DISTANCE;
    end = 1;
  } else {
    end = Math.min(1, start + MIN_NORMALIZED_DISTANCE);
    start = Math.max(0, end - MIN_NORMALIZED_DISTANCE);
  }
  return { start, length: end - start };
}

export function strokeBounds(
  points: ReadonlyArray<PreviewAnnotationNormalizedPoint>,
  width: number,
): PreviewAnnotationNormalizedRect {
  const first = points[0] ?? { x: 0, y: 0 };
  let minimumX = clampNormalized(first.x);
  let maximumX = minimumX;
  let minimumY = clampNormalized(first.y);
  let maximumY = minimumY;

  for (const point of points.slice(1)) {
    const x = clampNormalized(point.x);
    const y = clampNormalized(point.y);
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }

  const padding = Math.max(MIN_NORMALIZED_DISTANCE, width / 2);
  const horizontal = expandedPositiveRange(minimumX, maximumX, padding);
  const vertical = expandedPositiveRange(minimumY, maximumY, padding);
  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.length,
    height: vertical.length,
  };
}

export function makeStroke(input: {
  readonly id: string;
  readonly color: string;
  readonly width: number;
  readonly points: ReadonlyArray<PreviewAnnotationNormalizedPoint>;
}): PreviewAnnotationEditableStrokeV1 | null {
  if (input.points.length === 0) return null;
  const width = Math.max(
    MIN_NORMALIZED_DISTANCE,
    Math.min(1, Number.isFinite(input.width) ? input.width : DEFAULT_NORMALIZED_STROKE_WIDTH),
  );
  const points = input.points.map((point) => ({
    x: clampNormalized(point.x),
    y: clampNormalized(point.y),
  }));
  return {
    id: input.id,
    color: input.color,
    width,
    points,
    bounds: strokeBounds(points, width),
  };
}

export function addStroke(
  document: MarkupDocument,
  stroke: PreviewAnnotationEditableStrokeV1,
): MarkupDocument {
  return {
    ...document,
    strokes: [...document.strokes, stroke],
  };
}

export function deleteMarkupObject(
  document: MarkupDocument,
  selection: MarkupSelection | null,
): MarkupDocument {
  if (!selection) return document;
  if (selection.kind === "callout") {
    const callouts = document.callouts.filter((callout) => callout.id !== selection.id);
    return callouts.length === document.callouts.length ? document : { ...document, callouts };
  }

  const strokes = document.strokes.filter((stroke) => stroke.id !== selection.id);
  return strokes.length === document.strokes.length ? document : { ...document, strokes };
}

export function clearMarkupDocument(document: MarkupDocument): MarkupDocument {
  if (document.callouts.length === 0 && document.strokes.length === 0) {
    return document;
  }
  return EMPTY_MARKUP_DOCUMENT;
}

function squaredDistance(
  left: PreviewAnnotationNormalizedPoint,
  right: PreviewAnnotationNormalizedPoint,
): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function squaredDistanceToSegment(
  point: PreviewAnnotationNormalizedPoint,
  start: PreviewAnnotationNormalizedPoint,
  end: PreviewAnnotationNormalizedPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return squaredDistance(point, start);
  const progress = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return squaredDistance(point, {
    x: start.x + progress * dx,
    y: start.y + progress * dy,
  });
}

function pointTouchesRect(
  point: PreviewAnnotationNormalizedPoint,
  rect: PreviewAnnotationNormalizedRect,
  tolerance: number,
): boolean {
  return (
    point.x >= rect.x - tolerance &&
    point.x <= rect.x + rect.width + tolerance &&
    point.y >= rect.y - tolerance &&
    point.y <= rect.y + rect.height + tolerance
  );
}

export function hitTestMarkupObject(
  document: MarkupDocument,
  point: PreviewAnnotationNormalizedPoint,
  tolerance = 0.025,
): MarkupSelection | null {
  for (const callout of document.callouts.toReversed()) {
    if (callout.anchor.kind === "point") {
      if (squaredDistance(point, callout.anchor.point) <= tolerance * tolerance) {
        return { kind: "callout", id: callout.id };
      }
      continue;
    }
    if (pointTouchesRect(point, callout.anchor.rect, tolerance)) {
      return { kind: "callout", id: callout.id };
    }
  }

  for (const stroke of document.strokes.toReversed()) {
    if (!pointTouchesRect(point, stroke.bounds, tolerance + stroke.width / 2)) {
      continue;
    }
    const points = stroke.points;
    if (
      points.length === 1 &&
      squaredDistance(point, points[0]!) <= (tolerance + stroke.width / 2) ** 2
    ) {
      return { kind: "stroke", id: stroke.id };
    }
    for (let index = 1; index < points.length; index += 1) {
      if (
        squaredDistanceToSegment(point, points[index - 1]!, points[index]!) <=
        (tolerance + stroke.width / 2) ** 2
      ) {
        return { kind: "stroke", id: stroke.id };
      }
    }
  }

  return null;
}

export function eraseMarkupObjectAtPoint(
  document: MarkupDocument,
  point: PreviewAnnotationNormalizedPoint,
  tolerance = 0.035,
): MarkupDocument {
  return deleteMarkupObject(document, hitTestMarkupObject(document, point, tolerance));
}

export function createMarkupHistory(document: MarkupDocument): MarkupHistory {
  return {
    past: [],
    present: document,
    future: [],
  };
}

export function commitMarkupDocument(
  history: MarkupHistory,
  document: MarkupDocument,
): MarkupHistory {
  if (document === history.present) return history;
  return {
    past: [...history.past.slice(-(MAX_HISTORY_ENTRIES - 1)), history.present],
    present: document,
    future: [],
  };
}

export function undoMarkupHistory(history: MarkupHistory): MarkupHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, MAX_HISTORY_ENTRIES),
  };
}

export function redoMarkupHistory(history: MarkupHistory): MarkupHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past.slice(-(MAX_HISTORY_ENTRIES - 1)), history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function markupDocumentIsEmpty(document: MarkupDocument): boolean {
  return document.callouts.length === 0 && document.strokes.length === 0;
}

export function pathForNormalizedPoints(
  points: ReadonlyArray<PreviewAnnotationNormalizedPoint>,
  imageSize: MarkupSize,
): string {
  const first = points[0];
  if (!first) return "";
  const start = `${first.x * imageSize.width} ${first.y * imageSize.height}`;
  if (points.length === 1) return `M ${start} L ${start}`;
  return [
    `M ${start}`,
    ...points
      .slice(1)
      .map((point) => `L ${point.x * imageSize.width} ${point.y * imageSize.height}`),
  ].join(" ");
}

export function annotationExportSize(
  image: MarkupSize,
  options: {
    readonly maxEdge?: number;
    readonly maxPixels?: number;
  } = {},
): MarkupSize {
  if (image.width <= 0 || image.height <= 0) {
    return { width: 1, height: 1 };
  }
  const maxEdge = options.maxEdge ?? MAX_ANNOTATION_EXPORT_EDGE;
  const maxPixels = options.maxPixels ?? MAX_ANNOTATION_EXPORT_PIXELS;
  const edgeScale = maxEdge / Math.max(image.width, image.height);
  const pixelScale = Math.sqrt(maxPixels / (image.width * image.height));
  const scale = Math.min(1, edgeScale, pixelScale);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width * height <= maxPixels) return { width, height };
  const adjustedScale = Math.sqrt(maxPixels / (image.width * image.height));
  return {
    width: Math.max(1, Math.floor(image.width * adjustedScale)),
    height: Math.max(1, Math.floor(image.height * adjustedScale)),
  };
}

export function annotationExportLayoutSize(
  imagePixels: MarkupSize,
  pixelRatio: number,
): MarkupSize {
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return {
    width: Math.max(1 / safePixelRatio, imagePixels.width / safePixelRatio),
    height: Math.max(1 / safePixelRatio, imagePixels.height / safePixelRatio),
  };
}

export function remainingAnnotationExportByteBudget(
  originalSizeBytes: number,
  maximumCombinedBytes: number,
): number {
  const safeMaximum =
    Number.isFinite(maximumCombinedBytes) && maximumCombinedBytes > 0
      ? Math.floor(maximumCombinedBytes)
      : 0;
  const safeOriginal =
    Number.isFinite(originalSizeBytes) && originalSizeBytes > 0 ? Math.ceil(originalSizeBytes) : 0;
  return Math.max(0, safeMaximum - safeOriginal);
}

export function nextSmallerExportSize(size: MarkupSize): MarkupSize | null {
  if (Math.max(size.width, size.height) <= MIN_ANNOTATION_EXPORT_EDGE) {
    return null;
  }
  const scale = Math.max(
    0.75,
    Math.min(1, MIN_ANNOTATION_EXPORT_EDGE / Math.max(size.width, size.height)),
  );
  const next = {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
  if (next.width === size.width && next.height === size.height) return null;
  return next;
}
