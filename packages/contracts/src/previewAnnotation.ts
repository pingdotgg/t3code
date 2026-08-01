import * as Schema from "effect/Schema";

/**
 * Single stack frame captured by react-grab's `getElementContext`. We surface
 * the source file/line so coding agents can jump straight to the JSX that
 * produced the picked DOM node.
 */
export interface PickedElementStackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

/**
 * A successful element pick from the preview webview. All fields are
 * best-effort — pages that don't ship a React fiber tree (or aren't running
 * in dev) will still produce a usable payload (selector + html preview),
 * just without component / source attribution.
 */
export interface PickedElementPayload {
  /** URL of the page the element was picked on. */
  pageUrl: string;
  /** Optional `<title>` of that page (best-effort). */
  pageTitle: string | null;
  /** Lowercase tag name, e.g. `"button"`. */
  tagName: string;
  /** CSS selector resolving back to the element on a re-render. */
  selector: string | null;
  /** Truncated outer-HTML preview (matches react-grab's `htmlPreview`). */
  htmlPreview: string;
  /** Nearest React component display name, or null when unavailable. */
  componentName: string | null;
  /** First source-mapped stack frame (file + line of the JSX source). */
  source: PickedElementStackFrame | null;
  /** Full owner-stack frames; can be empty. Useful for richer context. */
  stack: ReadonlyArray<PickedElementStackFrame>;
  /** Author CSS only (UA defaults stripped) — react-grab's `styles`. */
  styles: string;
  /** Wall-clock pick time as ISO-8601 string. */
  pickedAt: string;
}

export const PickedElementPayloadSchema: Schema.Codec<PickedElementPayload> = Schema.Struct({
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PickedElementStackFrameSchema),
  stack: Schema.Array(PickedElementStackFrameSchema),
  styles: Schema.String,
  pickedAt: Schema.String,
});

/** Legacy preview geometry measured in viewport-relative CSS pixels. */
export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PreviewAnnotationRectSchema: Schema.Codec<PreviewAnnotationRect> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

/** Legacy preview point measured in viewport-relative CSS pixels. */
export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

export const PreviewAnnotationPointSchema: Schema.Codec<PreviewAnnotationPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationElementTargetSchema: Schema.Codec<PreviewAnnotationElementTarget> =
  Schema.Struct({
    id: Schema.String,
    element: PickedElementPayloadSchema,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationRegionTargetSchema: Schema.Codec<PreviewAnnotationRegionTarget> =
  Schema.Struct({
    id: Schema.String,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<PreviewAnnotationPoint>;
  bounds: PreviewAnnotationRect;
}

export const PreviewAnnotationStrokeTargetSchema: Schema.Codec<PreviewAnnotationStrokeTarget> =
  Schema.Struct({
    id: Schema.String,
    color: Schema.String,
    width: Schema.Number,
    points: Schema.Array(PreviewAnnotationPointSchema),
    bounds: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export const PreviewAnnotationStyleChangeSchema: Schema.Codec<PreviewAnnotationStyleChange> =
  Schema.Struct({
    targetId: Schema.String,
    selector: Schema.NullOr(Schema.String),
    property: Schema.String,
    previousValue: Schema.String,
    value: Schema.String,
  });

const NormalizedCoordinateSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const PositiveNormalizedDistanceSchema = NormalizedCoordinateSchema.check(Schema.isGreaterThan(0));

/** A point normalized against the final flattened annotation image. */
export interface PreviewAnnotationNormalizedPoint {
  x: number;
  y: number;
}

export const PreviewAnnotationNormalizedPointSchema: Schema.Codec<PreviewAnnotationNormalizedPoint> =
  Schema.Struct({
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  });

/** A rectangle normalized against the final flattened annotation image. */
export interface PreviewAnnotationNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const normalizedRectBoundsFilter = Schema.makeFilter(
  (rect: PreviewAnnotationNormalizedRect) =>
    (rect.x + rect.width <= 1 && rect.y + rect.height <= 1) ||
    "Normalized annotation rectangles must fit within the flattened image.",
);

export const PreviewAnnotationNormalizedRectSchema: Schema.Codec<PreviewAnnotationNormalizedRect> =
  Schema.Struct({
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
    width: PositiveNormalizedDistanceSchema,
    height: PositiveNormalizedDistanceSchema,
  }).check(normalizedRectBoundsFilter);

export interface PreviewAnnotationPointAnchor {
  kind: "point";
  point: PreviewAnnotationNormalizedPoint;
}

export const PreviewAnnotationPointAnchorSchema: Schema.Codec<PreviewAnnotationPointAnchor> =
  Schema.Struct({
    kind: Schema.Literal("point"),
    point: PreviewAnnotationNormalizedPointSchema,
  });

export interface PreviewAnnotationRegionAnchor {
  kind: "region";
  rect: PreviewAnnotationNormalizedRect;
}

export const PreviewAnnotationRegionAnchorSchema: Schema.Codec<PreviewAnnotationRegionAnchor> =
  Schema.Struct({
    kind: Schema.Literal("region"),
    rect: PreviewAnnotationNormalizedRectSchema,
  });

export interface PreviewAnnotationElementAnchor {
  kind: "element";
  /** References a target in the payload's legacy-compatible `elements` array. */
  targetId: string;
  rect: PreviewAnnotationNormalizedRect;
}

export const PreviewAnnotationElementAnchorSchema: Schema.Codec<PreviewAnnotationElementAnchor> =
  Schema.Struct({
    kind: Schema.Literal("element"),
    targetId: Schema.String,
    rect: PreviewAnnotationNormalizedRectSchema,
  });

export type PreviewAnnotationCalloutAnchor =
  | PreviewAnnotationPointAnchor
  | PreviewAnnotationRegionAnchor
  | PreviewAnnotationElementAnchor;

export const PreviewAnnotationCalloutAnchorSchema: Schema.Codec<PreviewAnnotationCalloutAnchor> =
  Schema.Union([
    PreviewAnnotationPointAnchorSchema,
    PreviewAnnotationRegionAnchorSchema,
    PreviewAnnotationElementAnchorSchema,
  ]);

export interface PreviewAnnotationCallout {
  id: string;
  /** Visible number burned into the flattened image. */
  number: number;
  comment: string;
  anchor: PreviewAnnotationCalloutAnchor;
}

export const PreviewAnnotationCalloutSchema: Schema.Codec<PreviewAnnotationCallout> = Schema.Struct(
  {
    id: Schema.String,
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    comment: Schema.String,
    anchor: PreviewAnnotationCalloutAnchorSchema,
  },
);

export interface PreviewAnnotationEditableStrokeV1 {
  id: string;
  color: string;
  /**
   * Stroke width normalized against the shorter side of the flattened image.
   */
  width: number;
  points: ReadonlyArray<PreviewAnnotationNormalizedPoint>;
  bounds: PreviewAnnotationNormalizedRect;
}

export const PreviewAnnotationEditableStrokeV1Schema: Schema.Codec<PreviewAnnotationEditableStrokeV1> =
  Schema.Struct({
    id: Schema.String,
    color: Schema.String,
    width: PositiveNormalizedDistanceSchema,
    points: Schema.Array(PreviewAnnotationNormalizedPointSchema),
    bounds: PreviewAnnotationNormalizedRectSchema,
  });

export interface PreviewAnnotationEditableVectorV1 {
  version: 1;
  coordinateSpace: "normalized";
  strokes: ReadonlyArray<PreviewAnnotationEditableStrokeV1>;
}

export const PreviewAnnotationEditableVectorV1Schema: Schema.Codec<PreviewAnnotationEditableVectorV1> =
  Schema.Struct({
    version: Schema.Literal(1),
    coordinateSpace: Schema.Literal("normalized"),
    strokes: Schema.Array(PreviewAnnotationEditableStrokeV1Schema),
  });

export interface PreviewAnnotationImageSource {
  kind: "image";
  name: string | null;
}

export const PreviewAnnotationImageSourceSchema: Schema.Codec<PreviewAnnotationImageSource> =
  Schema.Struct({
    kind: Schema.Literal("image"),
    name: Schema.NullOr(Schema.String),
  });

export interface PreviewAnnotationPreviewSource {
  kind: "preview";
  url: string;
  title: string | null;
}

export const PreviewAnnotationPreviewSourceSchema: Schema.Codec<PreviewAnnotationPreviewSource> =
  Schema.Struct({
    kind: Schema.Literal("preview"),
    url: Schema.String,
    title: Schema.NullOr(Schema.String),
  });

export type PreviewAnnotationSource = PreviewAnnotationImageSource | PreviewAnnotationPreviewSource;

export const PreviewAnnotationSourceSchema: Schema.Codec<PreviewAnnotationSource> = Schema.Union([
  PreviewAnnotationImageSourceSchema,
  PreviewAnnotationPreviewSourceSchema,
]);

export interface PreviewAnnotationScreenshot {
  dataUrl: string;
  /** Encoded image width in pixels. */
  width: number;
  /** Encoded image height in pixels. */
  height: number;
  /** Crop in the source preview's viewport-relative CSS-pixel coordinate space. */
  cropRect: PreviewAnnotationRect;
  /** Encoded-image pixels per source coordinate unit, when known. */
  scale?: number;
  /** Host-provided page revision captured with this exact frame, when known. */
  pageRevision?: string | null;
}

export const PreviewAnnotationScreenshotSchema: Schema.Codec<PreviewAnnotationScreenshot> =
  Schema.Struct({
    dataUrl: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    cropRect: PreviewAnnotationRectSchema,
    scale: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
    pageRevision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  });

/**
 * A submitted preview or image annotation. Legacy arrays remain required so
 * persisted drafts and mixed-version desktop hosts continue to round-trip.
 * New producers may additionally provide normalized numbered callouts and an
 * editable vector document.
 */
export interface PreviewAnnotationPayload {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: ReadonlyArray<PreviewAnnotationElementTarget>;
  regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
  screenshot: PreviewAnnotationScreenshot | null;
  createdAt: string;
  schemaVersion?: 1;
  source?: PreviewAnnotationSource;
  callouts?: ReadonlyArray<PreviewAnnotationCallout>;
  editable?: PreviewAnnotationEditableVectorV1 | null;
}

export const PreviewAnnotationPayloadSchema: Schema.Codec<PreviewAnnotationPayload> = Schema.Struct(
  {
    id: Schema.String,
    pageUrl: Schema.String,
    pageTitle: Schema.NullOr(Schema.String),
    comment: Schema.String,
    elements: Schema.Array(PreviewAnnotationElementTargetSchema),
    regions: Schema.Array(PreviewAnnotationRegionTargetSchema),
    strokes: Schema.Array(PreviewAnnotationStrokeTargetSchema),
    styleChanges: Schema.Array(PreviewAnnotationStyleChangeSchema),
    screenshot: Schema.NullOr(PreviewAnnotationScreenshotSchema),
    createdAt: Schema.String,
    schemaVersion: Schema.optionalKey(Schema.Literal(1)),
    source: Schema.optionalKey(PreviewAnnotationSourceSchema),
    callouts: Schema.optionalKey(Schema.Array(PreviewAnnotationCalloutSchema)),
    editable: Schema.optionalKey(Schema.NullOr(PreviewAnnotationEditableVectorV1Schema)),
  },
);
