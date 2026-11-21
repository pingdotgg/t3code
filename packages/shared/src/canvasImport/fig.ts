/**
 * .fig chunks contain a kiwi schema then Message nodeChanges/blobs, using deflate-raw
 * or zstd; newer downloads wrap canvas.fig, images/<sha1>, and meta.json in a ZIP.
 * parentIndex defines the tree. Instances expand SYMBOL children, with overrides
 * addressed through overrideKey paths in symbolOverrides and derivedSymbolData.
 */
import type { CanvasLayout, CanvasPaint, CanvasShadow, CanvasStroke } from "@t3tools/contracts";

import {
  bytesToHex,
  compactNode,
  type DraftNode,
  finiteOr,
  type ImportBuilder,
  isRecord,
  layoutSideBySide,
  rgbaToHex,
  round2,
  wrapRootsInFrame,
} from "./common.ts";
import { decodeKiwiMessage, decodeKiwiSchema } from "./kiwi.ts";
import { DecodeBudget, ImportLimitError, inflateWithin, zstdWithin } from "./limits.ts";
import { evenOddToNonzero, parseSvgPath, serializePath } from "./svgPath.ts";

type FigNode = Record<string, unknown>;
type Guid = { sessionID: number; localID: number };
type Matrix = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };

const FIG_PRELUDES = new Set(["fig-kiwi", "fig-jam.", "fig-deck"]);
const MAX_INSTANCE_DEPTH = 24;

export function isFigKiwi(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const prelude = new TextDecoder().decode(bytes.subarray(0, 8));
  return FIG_PRELUDES.has(prelude);
}

function decompressChunk(chunk: Uint8Array, budget: DecodeBudget): Uint8Array {
  if (chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd) {
    return zstdWithin(chunk, budget);
  }
  try {
    return inflateWithin(chunk, budget);
  } catch (error) {
    if (error instanceof ImportLimitError) throw error;
    // Some exporters store chunks uncompressed.
    return chunk;
  }
}

export interface FigMessage {
  nodeChanges: FigNode[];
  blobs: Uint8Array[];
}

/** Decodes the raw `fig-kiwi` container. Throws when the container itself is unreadable. */
export function decodeFigKiwi(bytes: Uint8Array, budget = new DecodeBudget()): FigMessage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset, true);
    const start = offset + 4;
    if (start + length > bytes.length) break;
    chunks.push(bytes.subarray(start, start + length));
    offset = start + length;
  }
  if (chunks.length < 2) throw new Error("The .fig file is missing its schema or data chunk");
  const schema = decodeKiwiSchema(decompressChunk(chunks[0]!, budget));
  const message = decodeKiwiMessage(schema, "Message", decompressChunk(chunks[1]!, budget));
  if (!isRecord(message)) throw new Error("The .fig data chunk is not a message");
  const nodeChanges = Array.isArray(message.nodeChanges)
    ? message.nodeChanges.filter(isRecord)
    : [];
  const blobs = Array.isArray(message.blobs)
    ? message.blobs.map((blob) =>
        isRecord(blob) && blob.bytes instanceof Uint8Array ? blob.bytes : new Uint8Array(),
      )
    : [];
  return { nodeChanges, blobs };
}

const guidKey = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const { sessionID, localID } = value as Guid;
  return typeof sessionID === "number" && typeof localID === "number"
    ? `${sessionID}:${localID}`
    : null;
};

const pathKey = (value: unknown): string | null => {
  if (!isRecord(value) || !Array.isArray(value.guids)) return null;
  const parts = value.guids.map(guidKey);
  return parts.every((part) => part !== null) ? parts.join("/") : null;
};

const MATRIX_KEYS = ["m00", "m01", "m02", "m10", "m11", "m12"] as const;

/** Corrupt files can decode NaN or Infinity; those transforms are ignored. */
const isMatrix = (value: unknown): value is Matrix =>
  isRecord(value) && MATRIX_KEYS.every((key) => Number.isFinite(value[key]));

const BLEND_MODES: Record<string, string> = {
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "plus-darker",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

const SKIPPED_TYPES = new Set(["SLICE", "VARIABLE", "VARIABLE_SET", "VARIABLE_OVERRIDE"]);
const CONTAINER_TYPES = new Set([
  "FRAME",
  "GROUP",
  "SYMBOL",
  "INSTANCE",
  "SECTION",
  "SLIDE",
  "SLIDE_GRID",
  "SLIDE_ROW",
  "TABLE",
  "TABLE_CELL",
  "RESPONSIVE_SET",
  "SHAPE_WITH_TEXT",
  "STICKY",
]);
const PATH_TYPES = new Set(["VECTOR", "STAR", "REGULAR_POLYGON", "BRUSH", "BOOLEAN_OPERATION"]);

function colorOf(value: unknown, opacity = 1): string | null {
  if (!isRecord(value)) return null;
  const { r, g, b, a } = value;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return null;
  return rgbaToHex(r, g, b, finiteOr(a, 1) * opacity);
}

interface FigContext {
  readonly builder: ImportBuilder;
  readonly byGuid: Map<string, FigNode>;
  readonly childrenOf: Map<string, FigNode[]>;
  readonly blobs: Uint8Array[];
  readonly images: Map<string, Uint8Array>;
}

/** Overrides keyed by an overrideKey path relative to the instance being expanded. */
interface OverrideMaps {
  readonly overrides: Map<string, FigNode[]>;
  readonly derived: Map<string, FigNode[]>;
}

const OVERRIDE_SKIP_KEYS = new Set(["guid", "guidPath", "parentIndex", "overrideKey", "type"]);

function applyPatches(node: FigNode, patches: ReadonlyArray<FigNode> | undefined): FigNode {
  if (!patches || patches.length === 0) return node;
  const next: FigNode = { ...node };
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (OVERRIDE_SKIP_KEYS.has(key) || value === undefined) continue;
      if (key === "symbolData" && isRecord(value) && isRecord(next.symbolData)) {
        // Overrides carry nested override lists; keep the symbol reference.
        next.symbolData = { ...next.symbolData, ...value };
        continue;
      }
      next[key] = value;
    }
  }
  return next;
}

function addEntries(target: Map<string, FigNode[]>, entries: unknown, prefix = ""): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = pathKey(entry.guidPath);
    if (!key) continue;
    const full = prefix ? `${prefix}/${key}` : key;
    const list = target.get(full);
    if (list) list.push(entry);
    else target.set(full, [entry]);
  }
}

/** Entries under `prefix/…`, re-keyed relative to `prefix`. */
function narrow(source: Map<string, FigNode[]>, prefix: string): Map<string, FigNode[]> {
  const result = new Map<string, FigNode[]>();
  const head = `${prefix}/`;
  for (const [key, list] of source) {
    if (key.startsWith(head)) result.set(key.slice(head.length), list);
  }
  return result;
}

const nodeOverrideKey = (node: FigNode) => guidKey(node.overrideKey) ?? guidKey(node.guid);

/** x/y of the unrotated box plus clockwise rotation about its center, from a Figma transform. */
function placement(transform: unknown, width: number, height: number) {
  if (!isMatrix(transform)) return { x: 0, y: 0, rotation: 0, flipped: false };
  const { m00, m01, m02, m10, m11, m12 } = transform;
  const centerX = m00 * (width / 2) + m01 * (height / 2) + m02;
  const centerY = m10 * (width / 2) + m11 * (height / 2) + m12;
  const rotation = (Math.atan2(m10, m00) * 180) / Math.PI;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    rotation: Math.abs(rotation) < 0.01 ? 0 : rotation,
    flipped: m00 * m11 - m01 * m10 < 0,
  };
}

function invertMatrix(m: Matrix): Matrix | null {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (Math.abs(det) < 1e-12) return null;
  return {
    m00: m.m11 / det,
    m01: -m.m01 / det,
    m02: (m.m01 * m.m12 - m.m11 * m.m02) / det,
    m10: -m.m10 / det,
    m11: m.m00 / det,
    m12: (m.m10 * m.m02 - m.m00 * m.m12) / det,
  };
}

function stopsOf(paint: FigNode, opacity: number) {
  if (!Array.isArray(paint.stops)) return [];
  return paint.stops.flatMap((stop) => {
    if (!isRecord(stop)) return [];
    const color = colorOf(stop.color, opacity);
    return color ? [{ offset: finiteOr(stop.position, 0), color }] : [];
  });
}

/**
 * Converts a Figma linear gradient (paint transform maps node-normalized
 * space to gradient space) into a CSS angle, remapping stops onto the CSS
 * gradient line so the rendered ramp matches.
 */
function linearGradient(paint: FigNode, opacity: number, width: number, height: number) {
  const stops = stopsOf(paint, opacity);
  const inverse = isMatrix(paint.transform) ? invertMatrix(paint.transform) : null;
  if (!inverse) return { type: "linear-gradient" as const, angle: 180, stops };
  const map = (x: number, y: number) => ({
    x: (inverse.m00 * x + inverse.m01 * y + inverse.m02) * width,
    y: (inverse.m10 * x + inverse.m11 * y + inverse.m12) * height,
  });
  const start = map(0, 0.5);
  const end = map(1, 0.5);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < 1e-6) return { type: "linear-gradient" as const, angle: 180, stops };
  const angleRad = Math.atan2(dx, -dy);
  const ux = Math.sin(angleRad);
  const uy = -Math.cos(angleRad);
  const length = Math.abs(width * ux) + Math.abs(height * uy) || 1;
  const project = (point: { x: number; y: number }) =>
    ((point.x - width / 2) * ux + (point.y - height / 2) * uy) / length + 0.5;
  const from = project(start);
  const to = project(end);
  return {
    type: "linear-gradient" as const,
    angle: round2(((((angleRad * 180) / Math.PI) % 360) + 360) % 360),
    stops: stops.map((stop) => ({
      ...stop,
      offset: Math.round((from + stop.offset * (to - from)) * 10_000) / 10_000,
    })),
  };
}

function convertPaints(
  ctx: FigContext,
  paints: unknown,
  width: number,
  height: number,
): CanvasPaint[] {
  if (!Array.isArray(paints)) return [];
  const result: CanvasPaint[] = [];
  for (const paint of paints) {
    if (!isRecord(paint) || paint.visible === false) continue;
    const opacity = finiteOr(paint.opacity, 1);
    switch (paint.type) {
      case "SOLID": {
        const color = colorOf(paint.color, opacity);
        if (color) result.push({ type: "solid", color });
        break;
      }
      case "GRADIENT_LINEAR":
        result.push(linearGradient(paint, opacity, width, height));
        break;
      case "GRADIENT_RADIAL":
      case "GRADIENT_DIAMOND":
        result.push({ type: "radial-gradient", stops: stopsOf(paint, opacity) });
        break;
      case "GRADIENT_ANGULAR":
        ctx.builder.warn("Angular gradients were imported as radial gradients");
        result.push({ type: "radial-gradient", stops: stopsOf(paint, opacity) });
        break;
      case "IMAGE": {
        const image = isRecord(paint.image) ? paint.image : null;
        const hash = image?.hash instanceof Uint8Array ? bytesToHex(image.hash) : null;
        const bytes =
          (hash && ctx.images.get(hash)) ||
          (image && typeof image.dataBlob === "number" ? ctx.blobs[image.dataBlob] : undefined);
        if (!hash || !bytes) {
          ctx.builder.warn("Some image fills had no image data in the file");
          break;
        }
        if (!ctx.builder.addImageAsset(hash, bytes)) {
          ctx.builder.warn("Some image fills use an unsupported image format");
          break;
        }
        const mode = paint.imageScaleMode;
        result.push({
          type: "image",
          assetId: hash,
          fit:
            mode === "FIT"
              ? "fit"
              : mode === "TILE"
                ? "tile"
                : mode === "STRETCH"
                  ? "crop"
                  : "fill",
        });
        break;
      }
      default:
        ctx.builder.warn(`Skipped unsupported ${String(paint.type).toLowerCase()} paints`);
    }
  }
  return result;
}

function convertStrokes(ctx: FigContext, node: FigNode, width: number, height: number) {
  const weight = finiteOr(node.strokeWeight, 0);
  if (weight <= 0) return [];
  const paints = convertPaints(ctx, node.strokePaints, width, height);
  const align =
    node.strokeAlign === "INSIDE"
      ? "inside"
      : node.strokeAlign === "OUTSIDE"
        ? "outside"
        : "center";
  const dash = Array.isArray(node.dashPattern)
    ? node.dashPattern.filter((value): value is number => typeof value === "number")
    : [];
  const strokes: CanvasStroke[] = [];
  for (const paint of paints) {
    let color: string | null = null;
    if (paint.type === "solid") color = paint.color;
    else if (
      (paint.type === "linear-gradient" || paint.type === "radial-gradient") &&
      paint.stops.length > 0
    ) {
      ctx.builder.warn("Gradient strokes were imported as solid strokes");
      color = paint.stops[0]!.color;
    }
    if (!color) continue;
    strokes.push({
      color,
      width: round2(weight),
      align,
      ...(dash.length > 0 ? { dash } : {}),
    });
  }
  return strokes;
}

/**
 * Per-side stroke weights (`borderStrokeWeightsIndependent`) have no stroke
 * equivalent; inset shadows paint the same as inside borders. Returns null
 * when the sides are uniform.
 */
function sideStrokeShadows(
  node: FigNode,
  strokes: ReadonlyArray<CanvasStroke>,
): CanvasShadow[] | null {
  if (node.borderStrokeWeightsIndependent !== true || strokes.length === 0) return null;
  const sides = {
    top: finiteOr(node.borderTopWeight, 0),
    right: finiteOr(node.borderRightWeight, 0),
    bottom: finiteOr(node.borderBottomWeight, 0),
    left: finiteOr(node.borderLeftWeight, 0),
  };
  if (sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left)
    return null;
  const color = strokes.at(-1)!.color;
  const shadows: CanvasShadow[] = [];
  if (sides.top)
    shadows.push({ x: 0, y: round2(sides.top), blur: 0, spread: 0, color, inset: true });
  if (sides.bottom)
    shadows.push({ x: 0, y: round2(-sides.bottom), blur: 0, spread: 0, color, inset: true });
  if (sides.left)
    shadows.push({ x: round2(sides.left), y: 0, blur: 0, spread: 0, color, inset: true });
  if (sides.right)
    shadows.push({ x: round2(-sides.right), y: 0, blur: 0, spread: 0, color, inset: true });
  return shadows;
}

function convertEffects(node: FigNode, draft: DraftNode): void {
  const shadows: CanvasShadow[] = [];
  const sideShadows = draft.strokes ? sideStrokeShadows(node, draft.strokes) : null;
  if (sideShadows) delete draft.strokes;
  for (const effect of Array.isArray(node.effects) ? node.effects : []) {
    if (!isRecord(effect) || effect.visible === false) continue;
    const radius = finiteOr(effect.radius, 0);
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const offset = isRecord(effect.offset) ? effect.offset : {};
      shadows.push({
        x: round2(finiteOr(offset.x, 0)),
        y: round2(finiteOr(offset.y, 0)),
        blur: round2(radius),
        spread: round2(finiteOr(effect.spread, 0)),
        color: colorOf(effect.color) ?? "#00000040",
        ...(effect.type === "INNER_SHADOW" ? { inset: true } : {}),
      });
    } else if (effect.type === "FOREGROUND_BLUR") {
      // Figma's blur radius is about twice the CSS blur() radius.
      draft.layerBlur = round2(radius / 2);
    } else if (effect.type === "BACKGROUND_BLUR") {
      draft.backgroundBlur = round2(radius / 2);
    }
  }
  if (sideShadows) shadows.push(...sideShadows);
  if (shadows.length > 0) draft.shadows = shadows;
}

function cornerRadiusOf(node: FigNode): DraftNode["cornerRadius"] {
  if (node.rectangleCornerRadiiIndependent === true) {
    const corners = [
      finiteOr(node.rectangleTopLeftCornerRadius, 0),
      finiteOr(node.rectangleTopRightCornerRadius, 0),
      finiteOr(node.rectangleBottomRightCornerRadius, 0),
      finiteOr(node.rectangleBottomLeftCornerRadius, 0),
    ] as const;
    if (corners.some((value) => value > 0)) {
      return corners.every((value) => value === corners[0])
        ? round2(corners[0])
        : [round2(corners[0]), round2(corners[1]), round2(corners[2]), round2(corners[3])];
    }
    return undefined;
  }
  const radius = finiteOr(node.cornerRadius, 0);
  return radius > 0 ? round2(radius) : undefined;
}

function layoutOf(node: FigNode): CanvasLayout | undefined {
  if (node.stackMode !== "HORIZONTAL" && node.stackMode !== "VERTICAL") return undefined;
  const uniform = finiteOr(node.stackPadding, 0);
  const left = finiteOr(node.stackHorizontalPadding, uniform);
  const top = finiteOr(node.stackVerticalPadding, uniform);
  const right = finiteOr(node.stackPaddingRight, left);
  const bottom = finiteOr(node.stackPaddingBottom, top);
  const justify = node.stackPrimaryAlignItems;
  const align = node.stackCounterAlignItems;
  return {
    direction: node.stackMode === "HORIZONTAL" ? "row" : "column",
    ...(finiteOr(node.stackSpacing, 0) !== 0
      ? { gap: round2(finiteOr(node.stackSpacing, 0)) }
      : {}),
    ...(left || top || right || bottom
      ? { padding: [round2(top), round2(right), round2(bottom), round2(left)] as const }
      : {}),
    ...(align === "CENTER"
      ? { align: "center" as const }
      : align === "MAX"
        ? { align: "end" as const }
        : {}),
    ...(justify === "CENTER"
      ? { justify: "center" as const }
      : justify === "MAX"
        ? { justify: "end" as const }
        : justify === "SPACE_BETWEEN" || justify === "SPACE_EVENLY"
          ? { justify: "space-between" as const }
          : {}),
    ...(node.stackWrap === "WRAP" ? { wrap: true } : {}),
  };
}

/** Tailwind sizing hints for auto layout children and hugging containers. */
function layoutClasses(node: FigNode, parentDirection: "row" | "column" | null): string[] {
  const classes: string[] = [];
  const layout = layoutOf(node);
  if (layout) {
    const primaryHug =
      node.stackPrimarySizing === "RESIZE_TO_FIT" ||
      node.stackPrimarySizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
    const counterHug =
      node.stackCounterSizing === "RESIZE_TO_FIT" ||
      node.stackCounterSizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
    if (primaryHug) classes.push(layout.direction === "row" ? "w-fit" : "h-fit");
    if (counterHug) classes.push(layout.direction === "row" ? "h-fit" : "w-fit");
  }
  if (parentDirection) {
    if (node.stackPositioning === "ABSOLUTE") classes.push("absolute");
    else {
      if (finiteOr(node.stackChildPrimaryGrow, 0) > 0) classes.push("flex-1");
      if (node.stackChildAlignSelf === "STRETCH") classes.push("self-stretch");
    }
  }
  return classes;
}

function textOf(node: FigNode): DraftNode["text"] {
  const textData = isRecord(node.textData) ? node.textData : {};
  const content = typeof textData.characters === "string" ? textData.characters : "";
  const fontSize = finiteOr(node.fontSize, 12);
  const fontName = isRecord(node.fontName) ? node.fontName : {};
  const derived = isRecord(node.derivedTextData) ? node.derivedTextData : {};
  const meta =
    Array.isArray(derived.fontMetaData) && isRecord(derived.fontMetaData[0])
      ? derived.fontMetaData[0]
      : null;
  const style = typeof fontName.style === "string" ? fontName.style : "";
  const fontWeight =
    meta && typeof meta.fontWeight === "number" ? meta.fontWeight : weightFromStyle(style);
  const italic = meta ? meta.fontStyle === "ITALIC" : /italic|oblique/i.test(style);
  const lineHeight = isRecord(node.lineHeight) ? node.lineHeight : null;
  const letterSpacing = isRecord(node.letterSpacing) ? node.letterSpacing : null;
  const fills = Array.isArray(node.fillPaints) ? node.fillPaints : [];
  const solid = fills.find(
    (paint): paint is FigNode =>
      isRecord(paint) && paint.type === "SOLID" && paint.visible !== false,
  );
  let lineHeightValue: number | undefined;
  if (lineHeight && typeof lineHeight.value === "number") {
    if (lineHeight.units === "PIXELS") lineHeightValue = lineHeight.value / fontSize;
    else if (lineHeight.units === "PERCENT") lineHeightValue = lineHeight.value / 100;
    else lineHeightValue = lineHeight.value;
    // PERCENT 100 is Figma's "auto" line height.
    if (lineHeight.units === "PERCENT" && lineHeight.value === 100) lineHeightValue = undefined;
  }
  let letterSpacingValue: number | undefined;
  if (letterSpacing && typeof letterSpacing.value === "number" && letterSpacing.value !== 0) {
    letterSpacingValue =
      letterSpacing.units === "PIXELS"
        ? letterSpacing.value
        : (letterSpacing.value / 100) * fontSize;
  }
  const horizontal = node.textAlignHorizontal;
  const vertical = node.textAlignVertical;
  const autoResize = node.textAutoResize;
  return compactNode({
    content,
    fontFamily: typeof fontName.family === "string" ? fontName.family : undefined,
    fontSize: round2(fontSize),
    fontWeight: fontWeight === 400 ? undefined : fontWeight,
    fontStyle: italic ? ("italic" as const) : undefined,
    lineHeight:
      lineHeightValue === undefined ? undefined : Math.round(lineHeightValue * 1000) / 1000,
    letterSpacing: letterSpacingValue === undefined ? undefined : round2(letterSpacingValue),
    align:
      horizontal === "CENTER"
        ? ("center" as const)
        : horizontal === "RIGHT"
          ? ("right" as const)
          : horizontal === "JUSTIFIED"
            ? ("justify" as const)
            : undefined,
    verticalAlign:
      vertical === "CENTER"
        ? ("middle" as const)
        : vertical === "BOTTOM"
          ? ("bottom" as const)
          : undefined,
    color: (solid && colorOf(solid.color, finiteOr(solid.opacity, 1))) ?? "#000000",
    sizing:
      autoResize === "WIDTH_AND_HEIGHT"
        ? ("auto-width" as const)
        : autoResize === "HEIGHT"
          ? ("auto-height" as const)
          : ("fixed" as const),
  });
}

function weightFromStyle(style: string): number {
  const name = style.toLowerCase().replaceAll(/[\s_-]/g, "");
  if (name.includes("thin") || name.includes("hairline")) return 100;
  if (name.includes("extralight") || name.includes("ultralight")) return 200;
  if (name.includes("semibold") || name.includes("demibold")) return 600;
  if (name.includes("extrabold") || name.includes("ultrabold")) return 800;
  if (name.includes("light")) return 300;
  if (name.includes("medium")) return 500;
  if (name.includes("bold")) return 700;
  if (name.includes("black") || name.includes("heavy")) return 900;
  return 400;
}

/** Decodes a geometry `commandsBlob` (opcode byte + float32 LE args) into SVG path data. */
function commandsBlobToPath(blob: Uint8Array): string | null {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const parts: string[] = [];
  let offset = 0;
  const read = (count: number) => {
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      values.push(String(round2(view.getFloat32(offset, true))));
      offset += 4;
    }
    return values.join(" ");
  };
  while (offset < blob.length) {
    const command = blob[offset++];
    const remaining = blob.length - offset;
    switch (command) {
      case 0:
        parts.push("Z");
        break;
      case 1:
        if (remaining < 8) return null;
        parts.push(`M${read(2)}`);
        break;
      case 2:
        if (remaining < 8) return null;
        parts.push(`L${read(2)}`);
        break;
      case 3:
        if (remaining < 16) return null;
        parts.push(`Q${read(4)}`);
        break;
      case 4:
        if (remaining < 24) return null;
        parts.push(`C${read(6)}`);
        break;
      default:
        return null;
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Decodes a vector network blob into its centerline as SVG path data, for
 * open vectors whose fill geometry is empty. Coordinates are scaled from
 * `normalizedSize` into the node's size.
 */
function vectorNetworkToPath(blob: Uint8Array, scaleX: number, scaleY: number): string | null {
  if (blob.length < 12) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vertexCount = view.getUint32(0, true);
  const segmentCount = view.getUint32(4, true);
  if (12 + vertexCount * 12 + segmentCount * 28 > blob.length) return null;
  const vertices: Array<[number, number]> = [];
  let offset = 12;
  for (let i = 0; i < vertexCount; i++) {
    vertices.push([
      view.getFloat32(offset + 4, true) * scaleX,
      view.getFloat32(offset + 8, true) * scaleY,
    ]);
    offset += 12;
  }
  const parts: string[] = [];
  let penVertex = -1;
  const point = (x: number, y: number) => `${round2(x)} ${round2(y)}`;
  for (let i = 0; i < segmentCount; i++) {
    const start = view.getUint32(offset + 4, true);
    const startDx = view.getFloat32(offset + 8, true) * scaleX;
    const startDy = view.getFloat32(offset + 12, true) * scaleY;
    const end = view.getUint32(offset + 16, true);
    const endDx = view.getFloat32(offset + 20, true) * scaleX;
    const endDy = view.getFloat32(offset + 24, true) * scaleY;
    offset += 28;
    const a = vertices[start];
    const b = vertices[end];
    if (!a || !b) return null;
    if (penVertex !== start) parts.push(`M${point(a[0], a[1])}`);
    if (startDx === 0 && startDy === 0 && endDx === 0 && endDy === 0) {
      parts.push(`L${point(b[0], b[1])}`);
    } else {
      parts.push(
        `C${point(a[0] + startDx, a[1] + startDy)} ${point(b[0] + endDx, b[1] + endDy)} ${point(b[0], b[1])}`,
      );
    }
    penVertex = end;
  }
  return parts.length > 0 ? parts.join("") : null;
}

function geometryPath(ctx: FigContext, geometry: unknown): string | null {
  if (!Array.isArray(geometry)) return null;
  const parts: string[] = [];
  for (const entry of geometry) {
    if (!isRecord(entry) || typeof entry.commandsBlob !== "number") continue;
    const blob = ctx.blobs[entry.commandsBlob];
    let path = blob ? commandsBlobToPath(blob) : null;
    if (path && entry.windingRule === "ODD") {
      // Canvas paths fill nonzero; reorient subpaths so holes stay holes.
      const commands = parseSvgPath(path);
      if (commands) path = serializePath(evenOddToNonzero(commands));
    }
    if (path) parts.push(path);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function sortedChildren(ctx: FigContext, node: FigNode): FigNode[] {
  const key = guidKey(node.guid);
  return key ? (ctx.childrenOf.get(key) ?? []) : [];
}

/**
 * Converts one node (and its subtree) under `parentId`. `maps` holds the
 * overrides of the enclosing instance, keyed relative to `path`.
 */
function convertNode(
  ctx: FigContext,
  source: FigNode,
  parentId: string | null,
  parentDirection: "row" | "column" | null,
  instance: { maps: OverrideMaps; path: string; depth: number } | null,
): void {
  if (!ctx.builder.canAdd()) return;
  let node = source;
  if (instance) {
    node = applyPatches(node, instance.maps.overrides.get(instance.path));
    node = applyPatches(node, instance.maps.derived.get(instance.path));
  }
  const type = typeof node.type === "string" ? node.type : "NONE";
  if (SKIPPED_TYPES.has(type)) return;

  const size = isRecord(node.size) ? node.size : {};
  const width = round2(Math.max(0, finiteOr(size.x, 0)));
  const height = round2(Math.max(0, finiteOr(size.y, 0)));
  const place = placement(node.transform, width, height);
  if (place.flipped) ctx.builder.warn("Mirrored layers were imported without their flip");

  const base: Omit<DraftNode, "id" | "parentId"> = {
    type: "rect",
    name: typeof node.name === "string" ? node.name : undefined,
    x: round2(place.x),
    y: round2(place.y),
    width,
    height,
    rotation: place.rotation ? round2(place.rotation) : undefined,
    opacity: finiteOr(node.opacity, 1) < 1 ? round2(finiteOr(node.opacity, 1)) : undefined,
    visible: node.visible === false ? false : undefined,
    locked: node.locked === true ? true : undefined,
    blendMode: typeof node.blendMode === "string" ? BLEND_MODES[node.blendMode] : undefined,
  };
  if (node.mask === true) {
    ctx.builder.warn("Masks are not supported; mask layers were hidden");
    base.visible = false;
  }
  const classes = layoutClasses(node, parentDirection);
  if (classes.length > 0) base.className = classes.join(" ");

  const fills = () => convertPaints(ctx, node.fillPaints, width, height);
  const strokes = () => convertStrokes(ctx, node, width, height);

  if (CONTAINER_TYPES.has(type)) {
    const isGroup =
      type === "GROUP" ||
      (type === "FRAME" &&
        node.resizeToFit === true &&
        !(Array.isArray(node.fillPaints) && node.fillPaints.length > 0) &&
        !(Array.isArray(node.strokePaints) && node.strokePaints.length > 0));
    const layout = layoutOf(node);
    const draft = ctx.builder.add(
      compactNode({
        ...base,
        type: isGroup ? ("group" as const) : ("frame" as const),
        fills: fills(),
        strokes: strokes(),
        cornerRadius: cornerRadiusOf(node),
        clipContent:
          !isGroup && type !== "SECTION" && node.frameMaskDisabled !== true ? true : undefined,
        layout,
      }),
      parentId,
    );
    convertEffects(node, draft);
    if (type === "STICKY" || type === "SHAPE_WITH_TEXT") {
      ctx.builder.warn(
        `FigJam ${type.toLowerCase().replace("_", " ")} nodes were imported as frames`,
      );
    }

    if (type === "INSTANCE") {
      expandInstance(ctx, node, draft.id, layout?.direction ?? null, instance);
      return;
    }
    for (const child of sortedChildren(ctx, node)) {
      const childPath = instance ? `${instance.path}/${nodeOverrideKey(child)}` : "";
      convertNode(
        ctx,
        child,
        draft.id,
        layout?.direction ?? null,
        instance ? { ...instance, path: childPath } : null,
      );
    }
    return;
  }

  if (type === "TEXT") {
    const draft = ctx.builder.add(
      compactNode({ ...base, type: "text" as const, text: textOf(node) }),
      parentId,
    );
    convertEffects(node, draft);
    const textData = isRecord(node.textData) ? node.textData : {};
    if (Array.isArray(textData.styleOverrideTable) && textData.styleOverrideTable.length > 0) {
      ctx.builder.warn("Mixed text styles were flattened to the first style");
    }
    return;
  }

  if (type === "RECTANGLE" || type === "ROUNDED_RECTANGLE") {
    const draft = ctx.builder.add(
      compactNode({
        ...base,
        type: "rect" as const,
        fills: fills(),
        strokes: strokes(),
        cornerRadius: cornerRadiusOf(node),
      }),
      parentId,
    );
    convertEffects(node, draft);
    return;
  }

  if (type === "LINE") {
    const draft = ctx.builder.add(
      compactNode({
        ...base,
        type: "line" as const,
        height: 0,
        path: `M0 0L${width} 0`,
        strokes: strokes(),
      }),
      parentId,
    );
    convertEffects(node, draft);
    return;
  }

  const arc = isRecord(node.arcData) ? node.arcData : null;
  const isPlainEllipse =
    type === "ELLIPSE" &&
    (!arc ||
      (finiteOr(arc.innerRadius, 0) === 0 &&
        Math.abs(finiteOr(arc.endingAngle, Math.PI * 2) - finiteOr(arc.startingAngle, 0)) >=
          Math.PI * 2 - 1e-3));
  if (isPlainEllipse) {
    const draft = ctx.builder.add(
      compactNode({ ...base, type: "ellipse" as const, fills: fills(), strokes: strokes() }),
      parentId,
    );
    convertEffects(node, draft);
    return;
  }

  if (PATH_TYPES.has(type) || type === "ELLIPSE") {
    let geometry = geometryPath(ctx, node.fillGeometry);
    const vectorData = isRecord(node.vectorData) ? node.vectorData : null;
    if (!geometry && vectorData && typeof vectorData.vectorNetworkBlob === "number") {
      const normalized = isRecord(vectorData.normalizedSize) ? vectorData.normalizedSize : {};
      const scaleX = finiteOr(normalized.x, 0) > 0 ? width / finiteOr(normalized.x, 1) : 1;
      const scaleY = finiteOr(normalized.y, 0) > 0 ? height / finiteOr(normalized.y, 1) : 1;
      const blob = ctx.blobs[vectorData.vectorNetworkBlob];
      const path = blob ? vectorNetworkToPath(blob, scaleX, scaleY) : null;
      if (path) geometry = path;
    }
    if (geometry) {
      const draft = ctx.builder.add(
        compactNode({
          ...base,
          type: "path" as const,
          path: geometry,
          fills: fills(),
          strokes: strokes(),
        }),
        parentId,
      );
      convertEffects(node, draft);
      return;
    }
    ctx.builder.warn(
      "Some vector shapes had no decodable geometry and were imported as rectangles",
    );
  } else {
    ctx.builder.warn(`Imported unsupported ${type.toLowerCase()} layers as rectangles`);
  }
  const draft = ctx.builder.add(
    compactNode({ ...base, type: "rect" as const, fills: fills(), strokes: strokes() }),
    parentId,
  );
  convertEffects(node, draft);
}

function expandInstance(
  ctx: FigContext,
  node: FigNode,
  draftId: string,
  direction: "row" | "column" | null,
  outer: { maps: OverrideMaps; path: string; depth: number } | null,
): void {
  const symbolData = isRecord(node.symbolData) ? node.symbolData : {};
  const symbolKey = guidKey(node.overriddenSymbolID) ?? guidKey(symbolData.symbolID);
  const symbol = symbolKey ? ctx.byGuid.get(symbolKey) : undefined;
  if (!symbol) {
    ctx.builder.warn("Some instances reference components missing from the file");
    return;
  }
  const depth = (outer?.depth ?? 0) + 1;
  if (depth > MAX_INSTANCE_DEPTH) {
    ctx.builder.warn("Stopped expanding deeply nested instances");
    return;
  }
  // Inner (component-level) overrides first, then the enclosing instance's.
  const overrides = new Map<string, FigNode[]>();
  const derived = new Map<string, FigNode[]>();
  addEntries(overrides, symbolData.symbolOverrides);
  addEntries(derived, node.derivedSymbolData);
  if (outer) {
    for (const [key, list] of narrow(outer.maps.overrides, outer.path)) {
      overrides.set(key, [...(overrides.get(key) ?? []), ...list]);
    }
    for (const [key, list] of narrow(outer.maps.derived, outer.path)) {
      derived.set(key, [...(derived.get(key) ?? []), ...list]);
    }
  }
  const maps = { overrides, derived };
  for (const child of sortedChildren(ctx, symbol)) {
    convertNode(ctx, child, draftId, direction, {
      maps,
      path: nodeOverrideKey(child) ?? "",
      depth,
    });
  }
}

/**
 * Converts a decoded `.fig` message into the builder. Each page becomes a
 * top-level frame; pages sit side by side starting at `originX`.
 */
export function importFigMessage(
  builder: ImportBuilder,
  message: FigMessage,
  images: Map<string, Uint8Array>,
): void {
  const byGuid = new Map<string, FigNode>();
  const childrenOf = new Map<string, FigNode[]>();
  let documentNode: FigNode | undefined;
  for (const node of message.nodeChanges) {
    if (node.phase === "REMOVED") continue;
    const key = guidKey(node.guid);
    if (!key) continue;
    byGuid.set(key, node);
    if (node.type === "DOCUMENT") documentNode ??= node;
    const parent = isRecord(node.parentIndex) ? guidKey(node.parentIndex.guid) : null;
    if (!parent) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(node);
    else childrenOf.set(parent, [node]);
  }
  const position = (node: FigNode) =>
    isRecord(node.parentIndex) && typeof node.parentIndex.position === "string"
      ? node.parentIndex.position
      : "";
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));
  }
  const ctx: FigContext = { builder, byGuid, childrenOf, blobs: message.blobs, images };

  const pages = documentNode
    ? sortedChildren(ctx, documentNode).filter((node) => node.type === "CANVAS")
    : message.nodeChanges.filter((node) => node.type === "CANVAS");
  const visiblePages = pages.filter((page) => page.internalOnly !== true);
  if (visiblePages.length === 0) {
    builder.warn("The .fig file has no pages");
    return;
  }
  const firstRoot = builder.rootIds.length;
  for (const page of visiblePages) {
    const pageStart = builder.rootIds.length;
    for (const child of sortedChildren(ctx, page)) convertNode(ctx, child, null, null, null);
    const background = page.backgroundEnabled === false ? null : colorOf(page.backgroundColor);
    const frame = wrapRootsInFrame(builder, pageStart, {
      type: "frame",
      name: typeof page.name === "string" ? page.name : "Page",
      ...(background ? { fills: [{ type: "solid", color: background }] } : {}),
    });
    if (!frame) builder.warn(`Skipped empty page ${String(page.name ?? "")}`.trim());
  }
  layoutSideBySide(builder, builder.rootIds.slice(firstRoot));
}
