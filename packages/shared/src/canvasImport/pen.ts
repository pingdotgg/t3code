/**
 * pencil.dev .pen imports expand refs and descendant overrides, resolve flex layout,
 * then emit parent-relative nodes. Fontless text layout uses width estimates.
 * Variables resolve by theme. Schema: https://docs.pencil.dev/for-developers/the-pen-format
 */
import type {
  CanvasLayout,
  CanvasNodeType,
  CanvasPaint,
  CanvasShadow,
  CanvasStroke,
} from "@t3tools/contracts";
import { CanvasShaderPaint } from "@t3tools/contracts";
import { Schema } from "effect";
import { makeCanvasNodeId } from "../canvasOps.ts";

import {
  compactNode,
  type DraftNode,
  finiteOr,
  type ImportBuilder,
  isRecord,
  normalizeHexColor,
  round2,
  withAlpha,
} from "./common.ts";
import { LucidePaths } from "./lucide.ts";
import { loadMaterialSymbols, type MaterialSymbolsPaths } from "./materialSymbols.ts";
import { evenOddToNonzero, parseSvgPath, pathBounds, serializePath } from "./svgPath.ts";

type PenNode = Record<string, unknown> & { type?: unknown; children?: unknown };
type Theme = Readonly<Record<string, string>>;

export interface PenDocument {
  readonly variables?: unknown;
  readonly themes?: unknown;
  readonly imports?: unknown;
  readonly children: ReadonlyArray<unknown>;
}

const MAX_REF_DEPTH = 32;
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 1.2;
const ICON_PLACEHOLDER_ALPHA = 0.3;
const NOTE_FILL = "#fff4c2";

/** Strips comments and trailing commas outside strings, then parses. */
export function parsePenJson(text: string): PenDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = JSON.parse(stripPenComments(text));
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.children)) {
    throw new Error("not a .pen document (missing children)");
  }
  return parsed as unknown as PenDocument;
}

/** Keep contiguous slices: per-character concatenation costs gigabytes on large snapshots. */
function stripPenComments(text: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
      continue;
    }
    if (char === '"') {
      inString = true;
      index++;
    } else if (char === "/" && text[index + 1] === "/") {
      parts.push(text.slice(start, index));
      while (index < text.length && text[index] !== "\n") index++;
      start = index;
    } else if (char === "/" && text[index + 1] === "*") {
      parts.push(text.slice(start, index));
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      start = index;
    } else if (char === ",") {
      let next = index + 1;
      for (;;) {
        while (next < text.length && /\s/.test(text[next]!)) next++;
        if (text[next] === "/" && text[next + 1] === "/") {
          while (next < text.length && text[next] !== "\n") next++;
        } else if (text[next] === "/" && text[next + 1] === "*") {
          const end = text.indexOf("*/", next + 2);
          next = end < 0 ? text.length : end + 2;
        } else break;
      }
      if (text[next] === "}" || text[next] === "]") {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
      index++;
    } else {
      index++;
    }
  }
  parts.push(text.slice(start));
  return parts.join("");
}

// Variables and themes

class Variables {
  private readonly definitions = new Map<string, unknown>();
  readonly defaultTheme: Theme;

  constructor(document: PenDocument) {
    if (isRecord(document.variables)) {
      for (const [name, definition] of Object.entries(document.variables)) {
        if (isRecord(definition)) this.definitions.set(name, definition.value);
      }
    }
    const theme: Record<string, string> = {};
    if (isRecord(document.themes)) {
      for (const [axis, values] of Object.entries(document.themes)) {
        if (Array.isArray(values) && typeof values[0] === "string") theme[axis] = values[0];
      }
    }
    this.defaultTheme = theme;
  }

  /** Resolves `$name` references (recursively) under `theme`; other values pass through. */
  resolve(value: unknown, theme: Theme, depth = 0): unknown {
    if (typeof value !== "string") return value;
    if (value.startsWith("\\$")) return value.slice(1);
    if (!value.startsWith("$") || depth > 16) return value;
    const name = value.slice(1);
    if (!this.definitions.has(name)) return value;
    let resolved = this.definitions.get(name);
    if (Array.isArray(resolved)) {
      // The last entry whose theme matches wins; entries without a theme always match.
      let picked: unknown = undefined;
      for (const entry of resolved) {
        if (!isRecord(entry)) continue;
        const entryTheme = isRecord(entry.theme) ? entry.theme : {};
        if (Object.entries(entryTheme).every(([axis, axisValue]) => theme[axis] === axisValue)) {
          picked = entry.value;
        }
      }
      if (picked === undefined) picked = isRecord(resolved[0]) ? resolved[0].value : undefined;
      resolved = picked;
    }
    return this.resolve(resolved, theme, depth + 1);
  }

  /** Resolves every `$variable` inside a value tree (fills, effects, padding arrays). */
  deep(value: unknown, theme: Theme): unknown {
    if (typeof value === "string") return this.resolve(value, theme);
    if (Array.isArray(value)) return value.map((item) => this.deep(item, theme));
    if (isRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = this.deep(item, theme);
      return result;
    }
    return value;
  }
}

// Ref expansion

const REF_META_KEYS = new Set(["type", "ref", "descendants", "reusable", "id"]);

type Overrides = Record<string, Record<string, unknown>>;

class RefExpander {
  private readonly components = new Map<string, PenNode>();
  private readonly builder: ImportBuilder;
  constructor(roots: ReadonlyArray<unknown>, builder: ImportBuilder) {
    this.builder = builder;
    const index = (node: unknown) => {
      if (!isRecord(node)) return;
      if (node.reusable === true && typeof node.id === "string") this.components.set(node.id, node);
      if (Array.isArray(node.children)) node.children.forEach(index);
    };
    roots.forEach(index);
  }

  /** Returns `node` with refs replaced by their component subtree and overrides applied. */
  expand(node: PenNode, overrides: Overrides, depth: number): PenNode | null {
    if (depth > MAX_REF_DEPTH) {
      this.builder.warn("Stopped expanding deeply nested or circular component refs");
      return null;
    }
    let current = node;
    let pending = overrides;
    // A component may itself be a ref to another component; unwrap until concrete.
    for (let hops = 0; current.type === "ref"; hops++) {
      const target = typeof current.ref === "string" ? this.components.get(current.ref) : undefined;
      if (!target || hops > MAX_REF_DEPTH) {
        this.builder.warn(
          typeof current.ref === "string" && current.ref.includes(":")
            ? "Refs to imported .pen libraries were skipped"
            : "Some component refs point at missing components",
        );
        return null;
      }
      const merged: PenNode = { ...target };
      for (const [key, value] of Object.entries(current)) {
        if (!REF_META_KEYS.has(key) && value !== undefined) merged[key] = value;
      }
      merged.id = current.id;
      delete merged.reusable;
      // The outer instance's overrides are more specific than the component's own.
      const own = isRecord(current.descendants) ? (current.descendants as Overrides) : {};
      pending = Object.assign({}, own, pending);
      if (target.type === "ref") {
        merged.type = "ref";
        merged.ref = target.ref;
        merged.descendants = target.descendants;
      } else {
        merged.type = target.type;
        delete merged.ref;
        delete merged.descendants;
      }
      current = merged;
    }
    if (!Array.isArray(current.children)) return current;
    const children: PenNode[] = [];
    for (const raw of current.children) {
      if (!isRecord(raw)) continue;
      let child: PenNode = raw;
      const id = typeof raw.id === "string" ? raw.id : null;
      const direct = id ? pending[id] : undefined;
      if (direct && isRecord(direct)) {
        if (typeof direct.type === "string") {
          child = direct;
        } else {
          child = { ...raw };
          for (const [key, value] of Object.entries(direct)) {
            if (key !== "id") child[key] = value;
          }
        }
      }
      const nested: Overrides = {};
      if (id) {
        const prefix = `${id}/`;
        for (const [path, patch] of Object.entries(pending)) {
          if (path.startsWith(prefix) && isRecord(patch)) nested[path.slice(prefix.length)] = patch;
        }
      }
      const expanded = this.expand(child, nested, depth + 1);
      if (expanded) children.push(expanded);
    }
    return { ...current, children };
  }
}

// Layout

type SizeSpec =
  | { kind: "fixed"; value: number }
  | { kind: "fill"; fallback: number | null }
  | { kind: "fit"; fallback: number | null };

type Direction = "none" | "horizontal" | "vertical";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A ref-expanded node with variables resolved under its theme, plus layout results. */
interface Resolved {
  readonly source: PenNode;
  readonly type: string;
  readonly theme: Theme;
  readonly get: (key: string) => unknown;
  readonly children: Resolved[];
  box: Box;
}

const parseSizeSpec = (value: unknown): SizeSpec | null => {
  if (typeof value === "number" && Number.isFinite(value))
    return { kind: "fixed", value: Math.max(0, value) };
  if (typeof value !== "string") return null;
  const match = /^(fill_container|fit_content)(?:\(\s*([-\d.]+)\s*\))?$/.exec(value.trim());
  if (!match) return null;
  const fallback = match[2] === undefined ? null : Number(match[2]);
  return {
    kind: match[1] === "fill_container" ? "fill" : "fit",
    fallback: fallback !== null && Number.isFinite(fallback) ? fallback : null,
  };
};

function directionOf(node: Resolved): Direction {
  const layout = node.get("layout");
  if (layout === "horizontal" || layout === "vertical" || layout === "none") return layout;
  return node.type === "frame" ? "horizontal" : "none";
}

function paddingOf(node: Resolved): Padding {
  const value = node.get("padding");
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  if (Array.isArray(value)) {
    const n = value.map((item) => finiteOr(item, 0));
    if (n.length === 2) return { top: n[0]!, right: n[1]!, bottom: n[0]!, left: n[1]! };
    if (n.length === 4) return { top: n[0]!, right: n[1]!, bottom: n[2]!, left: n[3]! };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

const isAbsolute = (node: Resolved) => node.get("layoutPosition") === "absolute";

const fontSizeOf = (node: Resolved) => finiteOr(node.get("fontSize"), DEFAULT_FONT_SIZE);

const textContent = (node: Resolved) => {
  const content = node.get("content");
  return typeof content === "string" ? content : "";
};

/** Rough advance width of one character as a fraction of the font size. */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (char === " ") return 0.28;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    code >= 0x1f300
  ) {
    return 1;
  }
  if (/[iljtf.,:;'|!]/.test(char)) return 0.3;
  if (/[mwMW]/.test(char)) return 0.85;
  if (/[A-Z0-9]/.test(char)) return 0.64;
  return 0.54;
}

function measureLine(line: string, fontSize: number, letterSpacing: number): number {
  let width = 0;
  for (const char of line) width += charWidth(char) * fontSize + letterSpacing;
  return width;
}

function textLineHeightPx(node: Resolved): number {
  return finiteOr(node.get("lineHeight"), DEFAULT_LINE_HEIGHT) * fontSizeOf(node);
}

function textIntrinsicWidth(node: Resolved): number {
  const fontSize = fontSizeOf(node);
  const letterSpacing = finiteOr(node.get("letterSpacing"), 0);
  return Math.ceil(
    Math.max(
      0,
      ...textContent(node)
        .split("\n")
        .map((line) => measureLine(line, fontSize, letterSpacing)),
    ),
  );
}

function textHeightForWidth(node: Resolved, width: number | null): number {
  const fontSize = fontSizeOf(node);
  const letterSpacing = finiteOr(node.get("letterSpacing"), 0);
  let lines = 0;
  for (const paragraph of textContent(node).split("\n")) {
    if (width === null || width <= 0) {
      lines += 1;
      continue;
    }
    // Greedy word wrap with the same width estimate as measureLine.
    let lineWidth = 0;
    let count = 1;
    for (const word of paragraph.split(/(\s+)/)) {
      const wordWidth = measureLine(word, fontSize, letterSpacing);
      if (lineWidth > 0 && lineWidth + wordWidth > width && word.trim() !== "") {
        count++;
        lineWidth = wordWidth;
      } else {
        lineWidth += wordWidth;
      }
    }
    lines += count;
  }
  return Math.ceil(Math.max(1, lines) * textLineHeightPx(node));
}

function textGrowth(node: Resolved): "auto" | "fixed-width" | "fixed-width-height" {
  const growth = node.get("textGrowth");
  return growth === "fixed-width" || growth === "fixed-width-height" ? growth : "auto";
}

function sizeSpecOf(node: Resolved, axis: "width" | "height"): SizeSpec {
  if (
    node.type === "text" ||
    node.type === "note" ||
    node.type === "prompt" ||
    node.type === "context"
  ) {
    const growth = node.type === "text" ? textGrowth(node) : "fixed-width-height";
    if (growth === "auto" || (growth === "fixed-width" && axis === "height")) {
      return { kind: "fit", fallback: null };
    }
  }
  const spec = parseSizeSpec(node.get(axis));
  if (spec) return spec;
  if (node.type === "frame" || node.type === "group") return { kind: "fit", fallback: null };
  if (node.type === "icon" || node.type === "icon_font") return { kind: "fixed", value: 24 };
  if (node.type === "path") return { kind: "fit", fallback: null };
  return { kind: "fixed", value: 0 };
}

/** Width a node wants on its own, ignoring fill sizing. */
function intrinsicWidth(node: Resolved): number {
  const spec = sizeSpecOf(node, "width");
  if (spec.kind === "fixed") return spec.value;
  if (node.type === "text") return textIntrinsicWidth(node);
  if (node.type === "path") return pathIntrinsicSize(node).width;
  if (node.children.length === 0) return spec.fallback ?? 0;
  const direction = directionOf(node);
  const padding = paddingOf(node);
  if (direction === "none") {
    let max = 0;
    for (const child of node.children)
      max = Math.max(max, finiteOr(child.get("x"), 0) + intrinsicWidth(child));
    return max;
  }
  const flow = node.children.filter((child) => !isAbsolute(child));
  const widths = flow.map(intrinsicWidth);
  const gap = finiteOr(node.get("gap"), 0);
  const content =
    direction === "horizontal"
      ? widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, flow.length - 1)
      : Math.max(0, ...widths);
  return content + padding.left + padding.right;
}

function pathIntrinsicSize(node: Resolved): { width: number; height: number } {
  const viewBox = node.get("viewBox");
  if (Array.isArray(viewBox) && viewBox.length === 4) {
    return { width: finiteOr(viewBox[2], 0), height: finiteOr(viewBox[3], 0) };
  }
  const geometry = node.get("geometry");
  const commands = typeof geometry === "string" ? parseSvgPath(geometry) : null;
  const bounds = commands ? pathBounds(commands) : null;
  return bounds ? { width: bounds.width, height: bounds.height } : { width: 0, height: 0 };
}

/**
 * Lays out `node` at the given width (and height, when fixed by the parent)
 * and returns its final height. Children boxes are written as it goes.
 */
function layoutNode(node: Resolved, width: number, fixedHeight: number | null): number {
  const heightSpec = sizeSpecOf(node, "height");
  if (
    node.type === "text" ||
    node.type === "note" ||
    node.type === "prompt" ||
    node.type === "context"
  ) {
    if (fixedHeight !== null) return fixedHeight;
    if (heightSpec.kind === "fixed") return heightSpec.value;
    const growth = node.type === "text" ? textGrowth(node) : "fixed-width-height";
    return textHeightForWidth(node, growth === "auto" ? null : width);
  }
  if (node.type === "path" && fixedHeight === null && heightSpec.kind !== "fixed") {
    return pathIntrinsicSize(node).height;
  }
  const ownHeight = fixedHeight ?? (heightSpec.kind === "fixed" ? heightSpec.value : null);
  if (node.children.length === 0) {
    return (
      ownHeight ?? (heightSpec.kind === "fixed" ? heightSpec.value : (heightSpec.fallback ?? 0))
    );
  }

  const direction = directionOf(node);
  const padding = paddingOf(node);
  const contentWidth = Math.max(0, width - padding.left - padding.right);

  if (direction === "none") {
    let maxBottom = 0;
    for (const child of node.children) {
      placeFree(child, width, ownHeight);
      maxBottom = Math.max(maxBottom, child.box.y + child.box.height);
    }
    return ownHeight ?? maxBottom;
  }

  const gap = finiteOr(node.get("gap"), 0);
  const flow = node.children.filter((child) => !isAbsolute(child));
  const horizontal = direction === "horizontal";
  const totalGap = gap * Math.max(0, flow.length - 1);

  // Widths first: text wrapping and nested layout depend on them.
  const widths = new Map<Resolved, number>();
  if (horizontal) {
    let used = totalGap;
    const fills: Resolved[] = [];
    for (const child of flow) {
      const spec = sizeSpecOf(child, "width");
      if (spec.kind === "fill") fills.push(child);
      else {
        const childWidth = spec.kind === "fixed" ? spec.value : intrinsicWidth(child);
        widths.set(child, childWidth);
        used += childWidth;
      }
    }
    const share = fills.length > 0 ? Math.max(0, contentWidth - used) / fills.length : 0;
    for (const child of fills) widths.set(child, share);
  } else {
    for (const child of flow) {
      const spec = sizeSpecOf(child, "width");
      widths.set(
        child,
        spec.kind === "fixed"
          ? spec.value
          : spec.kind === "fill"
            ? contentWidth
            : intrinsicWidth(child),
      );
    }
  }

  // Then heights.
  const heights = new Map<Resolved, number>();
  const contentHeight =
    ownHeight === null ? null : Math.max(0, ownHeight - padding.top - padding.bottom);
  if (horizontal) {
    let crossMax = 0;
    const crossFills: Resolved[] = [];
    for (const child of flow) {
      const spec = sizeSpecOf(child, "height");
      if (spec.kind === "fill" && contentHeight !== null) {
        crossFills.push(child);
        continue;
      }
      const childHeight = layoutNode(
        child,
        widths.get(child)!,
        spec.kind === "fixed" ? spec.value : null,
      );
      heights.set(child, childHeight);
      crossMax = Math.max(crossMax, childHeight);
    }
    for (const child of crossFills) {
      heights.set(child, layoutNode(child, widths.get(child)!, contentHeight ?? crossMax));
    }
  } else {
    let used = totalGap;
    const fills: Resolved[] = [];
    for (const child of flow) {
      const spec = sizeSpecOf(child, "height");
      if (spec.kind === "fill" && contentHeight !== null) {
        fills.push(child);
        continue;
      }
      const childHeight = layoutNode(
        child,
        widths.get(child)!,
        spec.kind === "fixed" ? spec.value : null,
      );
      heights.set(child, childHeight);
      used += childHeight;
    }
    const share =
      fills.length > 0 && contentHeight !== null
        ? Math.max(0, contentHeight - used) / fills.length
        : 0;
    for (const child of fills) heights.set(child, layoutNode(child, widths.get(child)!, share));
  }

  const mainSizes = flow.map((child) => (horizontal ? widths.get(child)! : heights.get(child)!));
  const crossSizes = flow.map((child) => (horizontal ? heights.get(child)! : widths.get(child)!));
  const mainTotal = mainSizes.reduce((sum, size) => sum + size, 0) + totalGap;
  const finalHeight =
    ownHeight ??
    (horizontal ? Math.max(0, ...crossSizes) : mainTotal) + padding.top + padding.bottom;
  const mainAvailable = horizontal
    ? contentWidth
    : Math.max(0, finalHeight - padding.top - padding.bottom);
  const crossAvailable = horizontal
    ? Math.max(0, finalHeight - padding.top - padding.bottom)
    : contentWidth;

  const justify = node.get("justifyContent");
  const align = node.get("alignItems");
  const free = mainAvailable - mainTotal;
  let cursor = horizontal ? padding.left : padding.top;
  let spacing = gap;
  if (justify === "center") cursor += free / 2;
  else if (justify === "end") cursor += free;
  else if (justify === "space_between" && flow.length > 1) {
    spacing = gap + free / (flow.length - 1);
  } else if (justify === "space_around" && flow.length > 0) {
    const around = (mainAvailable - (mainTotal - totalGap)) / flow.length;
    cursor += around / 2;
    spacing = around;
  }
  flow.forEach((child, index) => {
    const main = mainSizes[index]!;
    const cross = crossSizes[index]!;
    const crossStart = horizontal ? padding.top : padding.left;
    const crossOffset =
      align === "center"
        ? (crossAvailable - cross) / 2
        : align === "end"
          ? crossAvailable - cross
          : 0;
    child.box = horizontal
      ? { x: cursor, y: crossStart + crossOffset, width: main, height: cross }
      : { x: crossStart + crossOffset, y: cursor, width: cross, height: main };
    cursor += main + spacing;
  });
  for (const child of node.children) {
    if (isAbsolute(child)) placeFree(child, width, finalHeight);
  }
  return finalHeight;
}

/** Places a child that keeps its own x/y (parent without layout, or absolute). */
function placeFree(child: Resolved, parentWidth: number, parentHeight: number | null): void {
  const widthSpec = sizeSpecOf(child, "width");
  const heightSpec = sizeSpecOf(child, "height");
  const width =
    widthSpec.kind === "fixed"
      ? widthSpec.value
      : widthSpec.kind === "fill"
        ? (widthSpec.fallback ?? parentWidth)
        : intrinsicWidth(child);
  const fixedHeight =
    heightSpec.kind === "fixed"
      ? heightSpec.value
      : heightSpec.kind === "fill"
        ? (heightSpec.fallback ?? parentHeight)
        : null;
  const height = layoutNode(child, width, fixedHeight);
  child.box = { x: finiteOr(child.get("x"), 0), y: finiteOr(child.get("y"), 0), width, height };
}

// Emit

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

function fontWeightOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return FONT_WEIGHTS[value.toLowerCase().replaceAll(/[\s_-]/g, "")];
}

const asList = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const isEnabled = (value: unknown) => !(isRecord(value) && value.enabled === false);

interface EmitContext {
  readonly builder: ImportBuilder;
  readonly resolveAsset: (url: string) => Uint8Array | null;
  readonly assetIds: Map<string, string>;
  readonly lucide: LucidePaths;
  readonly materialSymbols: MaterialSymbolsPaths | null;
}

function convertFills(ctx: EmitContext, value: unknown, multiplier = 1): CanvasPaint[] {
  const paints: CanvasPaint[] = [];
  for (const fill of asList(value)) {
    if (!isEnabled(fill)) continue;
    if (typeof fill === "string") {
      const color = normalizeHexColor(fill);
      if (color) paints.push({ type: "solid", color: withAlpha(color, multiplier) });
      else if (fill !== "none" && fill !== "transparent")
        ctx.builder.warn(`Skipped unknown fill ${fill}`);
      continue;
    }
    if (!isRecord(fill)) continue;
    const opacity = finiteOr(fill.opacity, 1) * multiplier;
    switch (fill.type) {
      case "color": {
        const color = normalizeHexColor(fill.color);
        if (color) paints.push({ type: "solid", color: withAlpha(color, opacity) });
        break;
      }
      case "gradient": {
        const stops = asList(fill.colors).flatMap((stop) => {
          if (!isRecord(stop)) return [];
          const color = normalizeHexColor(stop.color);
          return color
            ? [{ offset: finiteOr(stop.position, 0), color: withAlpha(color, opacity) }]
            : [];
        });
        if (fill.gradientType === "radial" || fill.gradientType === "angular") {
          if (fill.gradientType === "angular") {
            ctx.builder.warn("Angular gradients were imported as radial gradients");
          }
          const center = isRecord(fill.center) ? fill.center : {};
          const size = isRecord(fill.size) ? fill.size : {};
          if (finiteOr(fill.rotation, 0) % 360 !== 0) {
            ctx.builder.warn("Radial gradient rotation was not imported");
          }
          paints.push({
            type: "radial-gradient",
            stops,
            center: { x: finiteOr(center.x, 0.5), y: finiteOr(center.y, 0.5) },
            size: {
              width: Math.max(0, finiteOr(size.width, 1)),
              height: Math.max(0, finiteOr(size.height, 1)),
            },
          });
        } else {
          // .pen rotation is counter-clockwise with 0 pointing up; CSS angles run clockwise.
          const rotation = finiteOr(fill.rotation, 0);
          paints.push({
            type: "linear-gradient",
            angle: round2(((-rotation % 360) + 360) % 360),
            stops,
          });
        }
        break;
      }
      case "image": {
        const url = typeof fill.url === "string" ? fill.url : null;
        const assetId = url ? imageAsset(ctx, url) : null;
        if (!assetId) break;
        paints.push({
          type: "image",
          assetId,
          fit: fill.mode === "contain" ? "fit" : fill.mode === "stretch" ? "stretch" : "fill",
        });
        break;
      }
      case "shader": {
        const paint = shaderPaint(ctx, fill, opacity);
        if (paint) paints.push(paint);
        break;
      }
      case "mesh_gradient": {
        const colors = asList(fill.colors)
          .map(normalizeHexColor)
          .filter((color) => color !== null);
        ctx.builder.warn("Mesh gradients were imported as linear gradients");
        if (colors.length > 0) {
          paints.push({
            type: "linear-gradient",
            angle: 135,
            stops: colors.map((color, index) => ({
              offset: colors.length === 1 ? 0 : index / (colors.length - 1),
              color: withAlpha(color, opacity),
            })),
          });
        }
        break;
      }
      default:
        ctx.builder.warn(`Skipped unsupported ${String(fill.type)} fills`);
    }
  }
  return paints;
}

const isShaderPaint = Schema.is(CanvasShaderPaint);

/** Pencil shader annotations bind clock/resolution and provide uniform defaults. */
function shaderPaint(
  ctx: EmitContext,
  fill: Record<string, unknown>,
  opacity: number,
): CanvasShaderPaint | null {
  const bytes = typeof fill.url === "string" ? ctx.resolveAsset(fill.url) : null;
  const source =
    typeof fill.source === "string" ? fill.source : bytes ? new TextDecoder().decode(bytes) : null;
  if (source === null) {
    ctx.builder.warn("Shader source is missing; include shader files in the .zip snapshot");
    return null;
  }
  if (source.length === 0 || source.length > 65_536) {
    ctx.builder.warn("Shader source exceeds the supported 64 KiB limit or is empty");
    return null;
  }
  const uniforms = new Map<string, unknown>();
  let timeUniform: string | undefined;
  let resolutionUniform: string | undefined;
  const annotatedUniform =
    /\/\*\*?([\s\S]*?)\*\/\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*;/g;
  for (const match of source.matchAll(annotatedUniform)) {
    const [, annotation, type, name] = match;
    if (!annotation || !name) continue;
    if (/@time\b/.test(annotation) && type === "float") timeUniform = name;
    if (/@resolution\b/.test(annotation) && type === "vec2") resolutionUniform = name;
    const defaultValue = /@default\s+([^\r\n*]+)/.exec(annotation)?.[1]?.trim();
    if (!defaultValue) continue;
    if (defaultValue.startsWith("#")) uniforms.set(name, defaultValue);
    else {
      try {
        uniforms.set(name, JSON.parse(defaultValue));
      } catch {
        // Unrecognized annotations leave the GLSL default unchanged.
      }
    }
  }
  if (isRecord(fill.uniforms)) {
    for (const [name, value] of Object.entries(fill.uniforms)) uniforms.set(name, value);
  }
  const paint = compactNode({
    type: "shader" as const,
    source,
    uniforms: Object.fromEntries(uniforms),
    timeUniform,
    resolutionUniform,
    opacity: opacity === 1 ? undefined : Math.max(0, Math.min(1, opacity)),
  });
  if (!isShaderPaint(paint)) {
    ctx.builder.warn("Shader uniforms exceed the supported limits or contain unsupported values");
    return null;
  }
  return paint;
}

function imageAsset(ctx: EmitContext, url: string): string | null {
  const known = ctx.assetIds.get(url);
  if (known) return known;
  const id = makeCanvasNodeId();
  if (/^data:/i.test(url)) {
    if (!ctx.builder.addImageDataAsset(id, url)) return null;
    ctx.assetIds.set(url, id);
    return id;
  }
  const bytes = ctx.resolveAsset(url);
  if (!bytes) {
    ctx.builder.warn(
      /^https?:/i.test(url)
        ? "Remote image fills were skipped; include images in a .zip snapshot"
        : "Some image fills reference files that are not in the import",
    );
    return null;
  }
  if (!ctx.builder.addImageAsset(id, bytes, /\.svg$/i.test(url))) {
    ctx.builder.warn("Some image fills use an unsupported image format");
    return null;
  }
  ctx.assetIds.set(url, id);
  return id;
}

interface StrokeResult {
  strokes: CanvasStroke[];
  /** Per-side strokes become inset shadows, which render the same for inside borders. */
  sideShadows: CanvasShadow[];
}

function convertStroke(ctx: EmitContext, node: Resolved): StrokeResult {
  const raw = node.get("stroke");
  let paints: unknown = raw;
  let width: unknown = node.get("strokeWidth");
  let alignment: unknown = node.get("strokeAlignment");
  // Older files use { align, thickness, fill }.
  if (isRecord(raw) && raw.type === undefined && ("fill" in raw || "thickness" in raw)) {
    if (raw.enabled === false) return { strokes: [], sideShadows: [] };
    paints = raw.fill;
    width = raw.thickness ?? width;
    alignment = raw.align ?? alignment;
  }
  const colors = convertFills(ctx, paints).flatMap((paint) => {
    if (paint.type === "solid") return [paint.color];
    if (paint.type === "shader") {
      ctx.builder.warn("Shader strokes are not supported and were skipped");
    } else if (paint.type !== "image" && paint.stops[0]) {
      ctx.builder.warn("Gradient strokes were imported as solid strokes");
      return [paint.stops[0].color];
    }
    return [];
  });
  if (colors.length === 0) return { strokes: [], sideShadows: [] };
  const align =
    alignment === "center" ||
    (alignment === undefined && (node.type === "path" || node.type === "line"))
      ? "center"
      : alignment === "outer" || alignment === "outside"
        ? "outside"
        : "inside";
  if (isRecord(width)) {
    const sides = {
      top: finiteOr(width.top, 0),
      right: finiteOr(width.right, 0),
      bottom: finiteOr(width.bottom, 0),
      left: finiteOr(width.left, 0),
    };
    const values = Object.values(sides);
    if (values.every((value) => value === values[0])) {
      width = values[0];
    } else {
      const color = colors.at(-1)!;
      const sideShadows: CanvasShadow[] = [];
      if (sides.top)
        sideShadows.push({ x: 0, y: sides.top, blur: 0, spread: 0, color, inset: true });
      if (sides.bottom)
        sideShadows.push({ x: 0, y: -sides.bottom, blur: 0, spread: 0, color, inset: true });
      if (sides.left)
        sideShadows.push({ x: sides.left, y: 0, blur: 0, spread: 0, color, inset: true });
      if (sides.right)
        sideShadows.push({ x: -sides.right, y: 0, blur: 0, spread: 0, color, inset: true });
      return { strokes: [], sideShadows };
    }
  }
  const strokeWidth = finiteOr(width, 1);
  if (strokeWidth <= 0) return { strokes: [], sideShadows: [] };
  return {
    strokes: colors.map((color) => ({ color, width: round2(strokeWidth), align })),
    sideShadows: [],
  };
}

function convertEffects(node: Resolved, draft: DraftNode, extraShadows: CanvasShadow[]): void {
  const shadows: CanvasShadow[] = [];
  for (const effect of asList(node.get("effect"))) {
    if (!isRecord(effect) || effect.enabled === false) continue;
    if (effect.type === "shadow") {
      const offset = isRecord(effect.offset) ? effect.offset : {};
      const color = normalizeHexColor(effect.color) ?? "#00000040";
      shadows.push({
        x: round2(finiteOr(offset.x, 0)),
        y: round2(finiteOr(offset.y, 0)),
        blur: round2(finiteOr(effect.blur, 0)),
        spread: round2(finiteOr(effect.spread, 0)),
        color,
        ...(effect.shadowType === "inner" ? { inset: true } : {}),
      });
    } else if (effect.type === "blur") {
      draft.layerBlur = round2(finiteOr(effect.radius, 0));
    } else if (effect.type === "background_blur") {
      draft.backgroundBlur = round2(finiteOr(effect.radius, 0));
    }
  }
  shadows.push(...extraShadows);
  if (shadows.length > 0) draft.shadows = shadows;
}

function cornerRadiusOf(value: unknown): DraftNode["cornerRadius"] {
  if (typeof value === "number") return value > 0 ? round2(value) : undefined;
  if (Array.isArray(value) && value.length === 4) {
    const corners = value.map((item) => round2(finiteOr(item, 0)));
    if (corners.every((corner) => corner === 0)) return undefined;
    if (corners.every((corner) => corner === corners[0])) return corners[0];
    return [corners[0]!, corners[1]!, corners[2]!, corners[3]!];
  }
  return undefined;
}

function layoutOf(node: Resolved): CanvasLayout | undefined {
  const direction = directionOf(node);
  if (direction === "none" || node.children.length === 0) return undefined;
  const padding = paddingOf(node);
  const gap = finiteOr(node.get("gap"), 0);
  const justify = node.get("justifyContent");
  const align = node.get("alignItems");
  return {
    direction: direction === "horizontal" ? "row" : "column",
    ...(gap ? { gap: round2(gap) } : {}),
    ...(padding.top || padding.right || padding.bottom || padding.left
      ? {
          padding: [
            round2(padding.top),
            round2(padding.right),
            round2(padding.bottom),
            round2(padding.left),
          ] as const,
        }
      : {}),
    ...(align === "center" || align === "end" ? { align } : {}),
    ...(justify === "center" || justify === "end"
      ? { justify }
      : justify === "space_between" || justify === "space_around"
        ? { justify: "space-between" as const }
        : {}),
  };
}

function sizingClasses(node: Resolved, parentDirection: Direction): string[] {
  const classes: string[] = [];
  const width = sizeSpecOf(node, "width").kind;
  const height = sizeSpecOf(node, "height").kind;
  const inFlow = parentDirection !== "none" && !isAbsolute(node);
  if (isAbsolute(node) && parentDirection !== "none") classes.push("absolute");
  if (inFlow) {
    const main = parentDirection === "horizontal" ? width : height;
    const cross = parentDirection === "horizontal" ? height : width;
    if (main === "fill") classes.push("flex-1");
    if (cross === "fill") classes.push("self-stretch");
  }
  const isContainer = node.type === "frame" || node.type === "group";
  if (isContainer && width === "fit" && node.children.length > 0) classes.push("w-fit");
  if (isContainer && height === "fit" && node.children.length > 0) classes.push("h-fit");
  if (node.type === "text") {
    if (node.get("underline") === true) classes.push("underline");
    if (node.get("strikethrough") === true) classes.push("line-through");
  }
  return classes;
}

/** CSS-convention placement: unrotated top-left plus clockwise rotation about the center. */
function placement(node: Resolved) {
  const rotationCcw = finiteOr(node.get("rotation"), 0);
  const { x, y, width, height } = node.box;
  if (!rotationCcw) return { x, y, rotation: 0 };
  // .pen rotates counter-clockwise about the top-left corner.
  const radians = (-rotationCcw * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = x + (width / 2) * cos - (height / 2) * sin;
  const centerY = y + (width / 2) * sin + (height / 2) * cos;
  return { x: centerX - width / 2, y: centerY - height / 2, rotation: -rotationCcw };
}

function polygonPath(sides: number, width: number, height: number): string {
  const count = Math.max(3, Math.round(sides));
  const points: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    points.push(
      `${round2(width / 2 + (width / 2) * Math.cos(angle))} ${round2(height / 2 + (height / 2) * Math.sin(angle))}`,
    );
  }
  return `M${points.join("L")}Z`;
}

const DEFAULT_NAMES: Record<CanvasNodeType, string> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  path: "Vector",
  text: "Text",
  image: "Image",
};

function emit(
  ctx: EmitContext,
  node: Resolved,
  parentId: string | null,
  parentDirection: Direction,
): void {
  if (!ctx.builder.canAdd()) return;
  const { x, y, rotation } = placement(node);
  const width = round2(node.box.width);
  const height = round2(node.box.height);
  const opacity = finiteOr(node.get("opacity"), 1);
  const name = node.get("name");
  const isIcon = node.type === "icon" || node.type === "icon_font";
  if (!isIcon && (node.get("flipX") === true || node.get("flipY") === true)) {
    ctx.builder.warn("Flipped layers were imported without their flip");
  }
  const classes = sizingClasses(node, parentDirection);
  const base: Omit<DraftNode, "id" | "parentId" | "type"> = {
    name: typeof name === "string" ? name : undefined,
    x: round2(x),
    y: round2(y),
    width,
    height,
    rotation: rotation ? round2(rotation) : undefined,
    opacity: opacity < 1 ? round2(Math.max(0, opacity)) : undefined,
    visible: node.get("enabled") === false ? false : undefined,
    className: classes.length > 0 ? classes.join(" ") : undefined,
  };

  const add = (fields: Omit<DraftNode, "id" | "parentId">) => {
    if (fields.type === "path" && fields.fills?.some((paint) => paint.type === "shader")) {
      ctx.builder.warn("Shader fills on vector paths are preserved but are not rendered");
    }
    const { strokes, sideShadows } = convertStroke(ctx, node);
    // Unnamed Pencil layers get Figma-style names so layer lists and exports stay readable.
    const name = fields.name ?? (fields.text?.content.slice(0, 40) || DEFAULT_NAMES[fields.type]);
    const draft = ctx.builder.add(
      compactNode({ ...fields, name, strokes: fields.type === "text" ? undefined : strokes }),
      parentId,
    );
    convertEffects(node, draft, sideShadows);
    return draft;
  };

  switch (node.type) {
    case "frame":
    case "group": {
      const draft = add({
        ...base,
        type: node.type === "group" ? "group" : "frame",
        fills: node.type === "frame" ? convertFills(ctx, node.get("fill")) : undefined,
        cornerRadius: cornerRadiusOf(node.get("cornerRadius")),
        clipContent: node.get("clip") === true ? true : undefined,
        layout: layoutOf(node),
      });
      const direction = directionOf(node);
      for (const child of node.children) emit(ctx, child, draft.id, direction);
      return;
    }
    case "rectangle":
      add({
        ...base,
        type: "rect",
        fills: convertFills(ctx, node.get("fill")),
        cornerRadius: cornerRadiusOf(node.get("cornerRadius")),
      });
      return;
    case "ellipse": {
      const inner = finiteOr(node.get("innerRadius"), 0);
      const sweep = finiteOr(node.get("sweepAngle"), 360);
      if (inner > 0 || Math.abs(sweep) < 360) {
        ctx.builder.warn("Rings and arcs were imported as full ellipses");
      }
      add({ ...base, type: "ellipse", fills: convertFills(ctx, node.get("fill")) });
      return;
    }
    case "polygon":
      add({
        ...base,
        type: "path",
        path: polygonPath(finiteOr(node.get("polygonCount"), 3), width, height),
        fills: convertFills(ctx, node.get("fill")),
      });
      return;
    case "line":
      add({ ...base, type: "line", path: `M0 0L${width} ${height}`, fills: undefined });
      return;
    case "path": {
      const geometry = node.get("geometry");
      const commands = typeof geometry === "string" ? parseSvgPath(geometry) : null;
      if (!commands) {
        ctx.builder.warn("Some paths had unreadable geometry and were imported as rectangles");
        add({ ...base, type: "rect", fills: convertFills(ctx, node.get("fill")) });
        return;
      }
      const viewBox = node.get("viewBox");
      const box =
        Array.isArray(viewBox) && viewBox.length === 4
          ? {
              x: finiteOr(viewBox[0], 0),
              y: finiteOr(viewBox[1], 0),
              width: finiteOr(viewBox[2], 0),
              height: finiteOr(viewBox[3], 0),
            }
          : pathBounds(commands);
      const scaleX = box && box.width > 0 ? width / box.width : 1;
      const scaleY = box && box.height > 0 ? height / box.height : 1;
      add({
        ...base,
        type: "path",
        path: serializePath(
          node.get("fillRule") === "evenodd" ? evenOddToNonzero(commands) : commands,
          (px, py) => [(px - (box?.x ?? 0)) * scaleX, (py - (box?.y ?? 0)) * scaleY],
        ),
        fills: convertFills(ctx, node.get("fill")),
      });
      return;
    }
    case "text":
      add({ ...base, type: "text", text: textOf(ctx, node) });
      return;
    case "note":
    case "prompt":
    case "context": {
      const frame = ctx.builder.add(
        compactNode({
          ...base,
          type: "frame" as const,
          fills: [{ type: "solid" as const, color: NOTE_FILL }],
          cornerRadius: 8,
        }),
        parentId,
      );
      const padding = 12;
      ctx.builder.add(
        compactNode({
          type: "text" as const,
          name: "Note",
          x: padding,
          y: padding,
          width: Math.max(0, width - padding * 2),
          height: Math.max(0, height - padding * 2),
          text: { ...textOf(ctx, node), color: "#3f3a24", sizing: "fixed" as const },
        }),
        frame.id,
      );
      return;
    }
    case "icon":
    case "icon_font": {
      const library = node.get("library") ?? node.get("iconFontFamily");
      const icon = node.get("icon") ?? node.get("iconFontName");
      if (
        typeof library === "string" &&
        library.toLowerCase() === "material symbols rounded" &&
        typeof icon === "string"
      ) {
        const path = ctx.materialSymbols?.get(
          icon,
          width,
          height,
          node.get("flipX") === true,
          node.get("flipY") === true,
        );
        if (path) {
          if (finiteOr(node.get("weight"), 400) !== 400) {
            ctx.builder.warn("Material Symbols weights other than 400 were imported at weight 400");
          }
          add({
            ...base,
            name: base.name ?? icon,
            type: "path",
            path,
            fills: convertFills(ctx, node.get("fill") ?? "#000000"),
          });
          return;
        }
      }
      const path =
        typeof library === "string" &&
        library.toLowerCase() === "lucide" &&
        typeof icon === "string"
          ? ctx.lucide.get(
              icon,
              width,
              height,
              node.get("flipX") === true,
              node.get("flipY") === true,
            )
          : null;
      if (path !== null) {
        const paints = convertFills(ctx, node.get("fill") ?? "#000000");
        const strokes = paints.flatMap((paint): CanvasStroke[] => {
          if (paint.type === "image" || paint.type === "shader") {
            ctx.builder.warn("Image and shader icon fills were skipped");
            return [];
          }
          if (paint.type !== "solid") {
            ctx.builder.warn("Gradient icon fills were imported as solid strokes");
          }
          const color = paint.type === "solid" ? paint.color : paint.stops[0]?.color;
          return color
            ? [{ color, width: round2((2 * Math.min(width, height)) / 24), align: "center" }]
            : [];
        });
        const draft = ctx.builder.add(
          compactNode({ ...base, name: base.name ?? String(icon), type: "path", path, strokes }),
          parentId,
        );
        convertEffects(node, draft, []);
        return;
      }
      ctx.builder.warn(
        typeof library === "string" && library.toLowerCase() === "lucide"
          ? "Unknown Lucide icons were imported as placeholders"
          : `Unsupported ${String(library ?? "unknown")} icons were imported as placeholders`,
      );
      if (node.get("flipX") === true || node.get("flipY") === true) {
        ctx.builder.warn("Flipped layers were imported without their flip");
      }
      const fills = convertFills(ctx, node.get("fill"), ICON_PLACEHOLDER_ALPHA);
      add({
        ...base,
        type: "rect",
        name: `${typeof base.name === "string" ? base.name : "Icon"} (${String(library ?? "icon")}: ${String(icon ?? "?")})`,
        fills:
          fills.length > 0
            ? fills
            : [{ type: "solid", color: withAlpha("#000000", ICON_PLACEHOLDER_ALPHA) }],
        cornerRadius: round2(Math.min(width, height) / 4),
      });
      return;
    }
    default:
      ctx.builder.warn(`Imported unsupported ${String(node.type)} objects as placeholders`);
      add({ ...base, type: "rect", fills: [{ type: "solid", color: "#88888833" }] });
  }
}

function textOf(ctx: EmitContext, node: Resolved): NonNullable<DraftNode["text"]> {
  const fills = convertFills(ctx, node.get("fill"));
  const solid = fills.find((paint) => paint.type === "solid");
  if (fills.some((paint) => paint.type === "shader"))
    ctx.builder.warn("Shader text fills are not supported and were imported as solid text");
  if (!solid && fills.length > 0)
    ctx.builder.warn("Gradient and image text fills were imported as solid text");
  const fontStyle = node.get("fontStyle");
  const align = node.get("textAlign");
  const vertical = node.get("textAlignVertical");
  const family = node.get("fontFamily");
  const growth = textGrowth(node);
  const weight = fontWeightOf(node.get("fontWeight"));
  const lineHeight = node.get("lineHeight");
  const letterSpacing = node.get("letterSpacing");
  const firstStop =
    fills[0] && (fills[0].type === "linear-gradient" || fills[0].type === "radial-gradient")
      ? fills[0].stops[0]?.color
      : undefined;
  return compactNode({
    content: textContent(node),
    fontFamily: typeof family === "string" ? family : undefined,
    fontSize: round2(fontSizeOf(node)),
    fontWeight: weight === undefined || weight === 400 ? undefined : weight,
    fontStyle:
      typeof fontStyle === "string" && /italic|oblique/i.test(fontStyle)
        ? ("italic" as const)
        : undefined,
    lineHeight: typeof lineHeight === "number" ? lineHeight : undefined,
    letterSpacing:
      typeof letterSpacing === "number" && letterSpacing !== 0 ? letterSpacing : undefined,
    align: align === "center" || align === "right" || align === "justify" ? align : undefined,
    verticalAlign: vertical === "middle" || vertical === "bottom" ? vertical : undefined,
    color: solid?.color ?? firstStop ?? "#000000",
    sizing:
      growth === "auto"
        ? ("auto-width" as const)
        : growth === "fixed-width"
          ? ("auto-height" as const)
          : ("fixed" as const),
  });
}

/** Keys whose values are literal names, not variable references. */
const LITERAL_KEYS = new Set([
  "id",
  "name",
  "type",
  "ref",
  "context",
  "metadata",
  "descendants",
  "children",
]);

function resolveTree(node: PenNode, variables: Variables, inherited: Theme): Resolved {
  const theme = isRecord(node.theme)
    ? { ...inherited, ...(node.theme as Record<string, string>) }
    : inherited;
  const cache = new Map<string, unknown>();
  const get = (key: string) => {
    if (cache.has(key)) return cache.get(key);
    const raw = node[key];
    const value = LITERAL_KEYS.has(key) ? raw : variables.deep(raw, theme);
    cache.set(key, value);
    return value;
  };
  const children = Array.isArray(node.children)
    ? node.children.filter(isRecord).map((child) => resolveTree(child, variables, theme))
    : [];
  return {
    source: node,
    type: typeof node.type === "string" ? node.type : "unknown",
    theme,
    get,
    children,
    box: { x: 0, y: 0, width: 0, height: 0 },
  };
}

/**
 * Imports a parsed `.pen` document into the builder. Top-level objects keep
 * their canvas positions. `resolveAsset` maps a relative image URL to bytes
 * (from a zip snapshot) or returns null.
 */
export async function importPenDocument(
  builder: ImportBuilder,
  document: PenDocument,
  resolveAsset: (url: string) => Uint8Array | null,
): Promise<void> {
  const variables = new Variables(document);
  if (isRecord(document.imports) && Object.keys(document.imports).length > 0) {
    builder.warn("Imported .pen libraries are not bundled; refs into them were skipped");
  }
  const expander = new RefExpander(document.children, builder);
  const ctx: EmitContext = {
    builder,
    resolveAsset,
    assetIds: new Map(),
    lucide: new LucidePaths(),
    materialSymbols: await loadMaterialSymbols(document),
  };
  for (const raw of document.children) {
    if (!isRecord(raw)) continue;
    const expanded = expander.expand(raw, {}, 0);
    if (!expanded) continue;
    const resolved = resolveTree(expanded, variables, variables.defaultTheme);
    placeFree(resolved, 0, null);
    emit(ctx, resolved, null, "none");
  }
}
