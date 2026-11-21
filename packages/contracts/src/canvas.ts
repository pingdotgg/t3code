/**
 * Documents use a flat node map with parent-relative geometry and CSS-shaped styles.
 * CanvasOp batches preserve those styles across GPU rendering and HTML export.
 */
import { Schema } from "effect";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CANVAS_DOCUMENT_VERSION = 1;
const CANVAS_OPS_MAX_ITEMS = 5_000;

export const CanvasDocumentId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type CanvasDocumentId = typeof CanvasDocumentId.Type;

export const CanvasNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type CanvasNodeId = typeof CanvasNodeId.Type;

/** `#rrggbb` or `#rrggbbaa`. */
export const CanvasColor = Schema.String.check(Schema.isPattern(/^#(?:[\da-f]{6}|[\da-f]{8})$/i));
export type CanvasColor = typeof CanvasColor.Type;

export const CanvasGradientStop = Schema.Struct({
  offset: Schema.Number,
  color: CanvasColor,
});
export type CanvasGradientStop = typeof CanvasGradientStop.Type;

export const CanvasImageFit = Schema.Literals(["fill", "fit", "crop", "tile", "stretch"]);
export type CanvasImageFit = typeof CanvasImageFit.Type;

const CanvasShaderUniformName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
);
const CanvasShaderNumber = Schema.Number.check(Schema.isFinite());
const isCanvasShaderUniformName = Schema.is(CanvasShaderUniformName);
export const CanvasShaderPaint = Schema.Struct({
  type: Schema.Literal("shader"),
  /** Original GLSL ES 1.00 fragment shader, compiled in an isolated WebGL worker. */
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  uniforms: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        CanvasShaderNumber,
        Schema.String.check(
          Schema.isPattern(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
        ),
        Schema.Array(CanvasShaderNumber).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
      ]),
    ).check(
      Schema.isMaxProperties(64),
      Schema.makeFilter((uniforms) => Object.keys(uniforms).every(isCanvasShaderUniformName)),
    ),
  ),
  timeUniform: Schema.optional(CanvasShaderUniformName),
  resolutionUniform: Schema.optional(CanvasShaderUniformName),
  opacity: Schema.optional(
    CanvasShaderNumber.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
});
export type CanvasShaderPaint = typeof CanvasShaderPaint.Type;

export const CanvasPaint = Schema.Union([
  Schema.Struct({ type: Schema.Literal("solid"), color: CanvasColor }),
  Schema.Struct({
    type: Schema.Literal("linear-gradient"),
    /** Degrees, CSS convention (0 = to top, 90 = to right). */
    angle: Schema.Number,
    stops: Schema.Array(CanvasGradientStop),
  }),
  Schema.Struct({
    type: Schema.Literal("radial-gradient"),
    stops: Schema.Array(CanvasGradientStop),
    /** Center as fractions of the node's width and height; defaults to 0.5, 0.5. */
    center: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
    /** Ellipse diameters as fractions of the node's bounds. Omitted keeps farthest-corner sizing. */
    size: Schema.optional(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    assetId: TrimmedNonEmptyString,
    fit: CanvasImageFit,
  }),
  CanvasShaderPaint,
]);
export type CanvasPaint = typeof CanvasPaint.Type;

export const CanvasStroke = Schema.Struct({
  color: CanvasColor,
  width: Schema.Number,
  align: Schema.optional(Schema.Literals(["inside", "center", "outside"])),
  dash: Schema.optional(Schema.Array(Schema.Number)),
});
export type CanvasStroke = typeof CanvasStroke.Type;

export const CanvasShadow = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  blur: Schema.Number,
  spread: Schema.Number,
  color: CanvasColor,
  inset: Schema.optional(Schema.Boolean),
});
export type CanvasShadow = typeof CanvasShadow.Type;

/** Flexbox-shaped auto layout, applied to a frame's children. */
export const CanvasLayout = Schema.Struct({
  direction: Schema.Literals(["row", "column"]),
  gap: Schema.optional(Schema.Number),
  padding: Schema.optional(
    Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
  ),
  align: Schema.optional(Schema.Literals(["start", "center", "end", "stretch"])),
  justify: Schema.optional(Schema.Literals(["start", "center", "end", "space-between"])),
  wrap: Schema.optional(Schema.Boolean),
});
export type CanvasLayout = typeof CanvasLayout.Type;

export const CanvasText = Schema.Struct({
  content: Schema.String,
  fontFamily: Schema.optional(Schema.String),
  fontSize: Schema.Number,
  fontWeight: Schema.optional(Schema.Number),
  fontStyle: Schema.optional(Schema.Literals(["normal", "italic"])),
  lineHeight: Schema.optional(Schema.Number),
  letterSpacing: Schema.optional(Schema.Number),
  align: Schema.optional(Schema.Literals(["left", "center", "right", "justify"])),
  verticalAlign: Schema.optional(Schema.Literals(["top", "middle", "bottom"])),
  color: CanvasColor,
  /** `auto-width` grows horizontally, `auto-height` wraps at width, `fixed` clips. */
  sizing: Schema.optional(Schema.Literals(["auto-width", "auto-height", "fixed"])),
});
export type CanvasText = typeof CanvasText.Type;

export const CanvasAnimatableProperty = Schema.Literals([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "scale",
  "cornerRadius",
  "fill",
]);
export type CanvasAnimatableProperty = typeof CanvasAnimatableProperty.Type;

export const CanvasEasing = Schema.Literals([
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "spring",
]);
export type CanvasEasing = typeof CanvasEasing.Type;

export const CanvasKeyframe = Schema.Struct({
  /** 0..1 progress through the animation. */
  offset: Schema.Number,
  /** Number for numeric properties, color string for `fill`. */
  value: Schema.Union([Schema.Number, CanvasColor]),
  easing: Schema.optional(CanvasEasing),
});
export type CanvasKeyframe = typeof CanvasKeyframe.Type;

export const CanvasAnimation = Schema.Struct({
  id: TrimmedNonEmptyString,
  property: CanvasAnimatableProperty,
  keyframes: Schema.Array(CanvasKeyframe),
  durationMs: Schema.Number,
  delayMs: Schema.optional(Schema.Number),
  /** `true` loops forever, a number repeats that many times. */
  loop: Schema.optional(Schema.Union([Schema.Boolean, Schema.Number])),
  alternate: Schema.optional(Schema.Boolean),
  trigger: Schema.optional(Schema.Literals(["load", "hover", "press"])),
});
export type CanvasAnimation = typeof CanvasAnimation.Type;

export const CanvasNodeType = Schema.Literals([
  "frame",
  "group",
  "rect",
  "ellipse",
  "line",
  "path",
  "text",
  "image",
]);
export type CanvasNodeType = typeof CanvasNodeType.Type;

export const CanvasCornerRadius = Schema.Union([
  Schema.Number,
  Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
]);
export type CanvasCornerRadius = typeof CanvasCornerRadius.Type;

export const CanvasNode = Schema.Struct({
  id: CanvasNodeId,
  type: CanvasNodeType,
  name: Schema.optional(Schema.String),
  parentId: Schema.NullOr(CanvasNodeId),
  /** Ordered back-to-front. */
  childIds: Schema.optional(Schema.Array(CanvasNodeId)),
  /** Parent-relative geometry in canvas units (CSS px at zoom 1). */
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  rotation: Schema.optional(Schema.Number),
  opacity: Schema.optional(Schema.Number),
  visible: Schema.optional(Schema.Boolean),
  locked: Schema.optional(Schema.Boolean),
  clipContent: Schema.optional(Schema.Boolean),
  blendMode: Schema.optional(Schema.String),
  fills: Schema.optional(Schema.Array(CanvasPaint)),
  strokes: Schema.optional(Schema.Array(CanvasStroke)),
  cornerRadius: Schema.optional(CanvasCornerRadius),
  shadows: Schema.optional(Schema.Array(CanvasShadow)),
  layerBlur: Schema.optional(Schema.Number),
  backgroundBlur: Schema.optional(Schema.Number),
  layout: Schema.optional(CanvasLayout),
  text: Schema.optional(CanvasText),
  /** SVG path data in node-local coordinates, for `path` and `line`. */
  path: Schema.optional(Schema.String),
  animations: Schema.optional(Schema.Array(CanvasAnimation)),
  /** Tailwind classes this node maps to, kept from imports and used by export. */
  className: Schema.optional(Schema.String),
});
export type CanvasNode = typeof CanvasNode.Type;

export const CanvasAsset = Schema.Struct({
  id: TrimmedNonEmptyString,
  mimeType: Schema.String,
  /** `data:` URL. */
  url: Schema.String,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});
export type CanvasAsset = typeof CanvasAsset.Type;

export const CanvasDocument = Schema.Struct({
  version: Schema.Literal(CANVAS_DOCUMENT_VERSION),
  id: CanvasDocumentId,
  projectId: ProjectId,
  name: Schema.String,
  revision: NonNegativeInt,
  /** Top-level node ids, back-to-front. */
  rootIds: Schema.Array(CanvasNodeId),
  nodes: Schema.Record(Schema.String, CanvasNode),
  assets: Schema.Record(Schema.String, CanvasAsset),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CanvasDocument = typeof CanvasDocument.Type;

export const CanvasDocumentSummary = Schema.Struct({
  id: CanvasDocumentId,
  projectId: ProjectId,
  name: Schema.String,
  revision: NonNegativeInt,
  nodeCount: NonNegativeInt,
  updatedAt: Schema.String,
});
export type CanvasDocumentSummary = typeof CanvasDocumentSummary.Type;

/** A partial node update. `null` clears an optional field. */
export const CanvasNodePatch = Schema.Record(Schema.String, Schema.Unknown);
export type CanvasNodePatch = typeof CanvasNodePatch.Type;

export const CanvasOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("insert"),
    node: CanvasNode,
    /** Defaults to appending (front-most). */
    index: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({ op: Schema.Literal("update"), id: CanvasNodeId, patch: CanvasNodePatch }),
  Schema.Struct({ op: Schema.Literal("delete"), id: CanvasNodeId }),
  Schema.Struct({
    op: Schema.Literal("move"),
    id: CanvasNodeId,
    parentId: Schema.NullOr(CanvasNodeId),
    index: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({ op: Schema.Literal("put-asset"), asset: CanvasAsset }),
  Schema.Struct({ op: Schema.Literal("rename"), name: Schema.String }),
]);
export type CanvasOp = typeof CanvasOp.Type;

export const CanvasOpBatch = Schema.Array(CanvasOp).check(Schema.isMaxLength(CANVAS_OPS_MAX_ITEMS));
export type CanvasOpBatch = typeof CanvasOpBatch.Type;

/**
 * A snapshot's document on the wire. The server validates documents when it
 * stores them (ops are decoded, imports are checked before the first write),
 * so the stream only checks that the payload is a JSON object. A full schema
 * pass over a 50k-node document costs about 0.7 s on each side.
 */
const CanvasDocumentSnapshot = Schema.declare(
  (input): input is CanvasDocument =>
    typeof input === "object" &&
    input !== null &&
    "nodes" in input &&
    "rootIds" in input &&
    "assets" in input,
);

/** Streamed to subscribers of one document. */
export const CanvasDocumentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), document: CanvasDocumentSnapshot }),
  Schema.Struct({
    type: Schema.Literal("ops"),
    revision: NonNegativeInt,
    ops: CanvasOpBatch,
    /** Echoed so the originating client can skip re-applying its own batch. */
    clientBatchId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("deleted") }),
]);
export type CanvasDocumentEvent = typeof CanvasDocumentEvent.Type;
