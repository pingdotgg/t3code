import type { CanvasAsset, CanvasNode } from "@t3tools/contracts";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";

import { makeCanvasNodeId } from "../canvasOps.ts";
import { readImageDimensions } from "../imageDimensions.ts";

export interface CanvasImportResult {
  name: string;
  rootIds: string[];
  nodes: Record<string, CanvasNode>;
  assets: Record<string, CanvasAsset>;
  warnings: string[];
}

/** Mutable node with optional fields writable, used while an importer builds the tree. */
export type DraftNode = { -readonly [K in keyof CanvasNode]: CanvasNode[K] } & {
  childIds?: string[];
};

/** Room between pages or documents that are laid out side by side. */
const SIDE_BY_SIDE_GAP = 200;

/** Upper bound on imported nodes so a hostile or huge file cannot exhaust memory. */
const MAX_IMPORTED_NODES = 250_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SIDE = 16_384;
const MAX_PIXELS = 64 * 1024 * 1024;

/**
 * Accumulates nodes, assets, and warnings while an importer walks a source
 * tree. Repeated warnings collapse into one line with a count.
 */
export class ImportBuilder {
  readonly nodes: Record<string, DraftNode> = {};
  readonly assets: Record<string, CanvasAsset> = {};
  readonly rootIds: string[] = [];
  private readonly warningCounts = new Map<string, number>();
  private nodeCount = 0;
  limitReached = false;

  warn(message: string): void {
    this.warningCounts.set(message, (this.warningCounts.get(message) ?? 0) + 1);
  }

  /** Returns false once the node budget is spent; the caller should stop descending. */
  canAdd(): boolean {
    if (this.nodeCount < MAX_IMPORTED_NODES) return true;
    if (!this.limitReached) {
      this.limitReached = true;
      this.warn(`Stopped after ${MAX_IMPORTED_NODES} nodes; the rest of the file was skipped`);
    }
    return false;
  }

  /** Adds a node under `parentId` (front-most) and returns it. */
  add(node: Omit<DraftNode, "id" | "parentId">, parentId: string | null): DraftNode {
    const id = makeCanvasNodeId();
    const draft = { ...node, id, parentId } as DraftNode;
    this.nodes[id] = draft;
    this.nodeCount++;
    if (parentId === null) {
      this.rootIds.push(id);
    } else {
      const parent = this.nodes[parentId];
      if (parent) (parent.childIds ??= []).push(id);
    }
    return draft;
  }

  /** Removes a node and its subtree, for instance when a container ends up empty. */
  remove(id: string): void {
    const node = this.nodes[id];
    if (!node) return;
    for (const childId of node.childIds ?? []) this.remove(childId);
    delete this.nodes[id];
    this.nodeCount--;
    if (node.parentId === null) {
      const index = this.rootIds.indexOf(id);
      if (index >= 0) this.rootIds.splice(index, 1);
    } else {
      const parent = this.nodes[node.parentId];
      if (parent?.childIds) parent.childIds = parent.childIds.filter((childId) => childId !== id);
    }
  }

  /** Every imported image uses the same limits, including embedded fills. */
  addImageAsset(id: string, input: Uint8Array, svg = false): CanvasAsset | null {
    const existing = this.assets[id];
    if (existing) return existing;
    try {
      const mimeType = svg ? "image/svg+xml" : sniffImageMimeType(input);
      if (!mimeType) return null;
      const sanitized =
        mimeType === "image/svg+xml"
          ? sanitizeSvg(new TextDecoder().decode(input), this)
          : undefined;
      const bytes = sanitized ? new TextEncoder().encode(sanitized.source) : input;
      const dimensions = sanitized ?? readImageDimensions(bytes);
      if (!dimensions) throw new Error("The image has no readable dimensions");
      checkDimensions(dimensions.width, dimensions.height);
      const asset: CanvasAsset = {
        id,
        mimeType,
        url: bytesToDataUrl(bytes, mimeType),
        width: dimensions.width,
        height: dimensions.height,
      };
      this.assets[id] = asset;
      return asset;
    } catch (error) {
      this.warn(error instanceof Error ? error.message : "The image could not be imported");
      return null;
    }
  }

  /** Decode inline bytes before applying the same checks as archived images. */
  addImageDataAsset(id: string, url: string): CanvasAsset | null {
    try {
      const match =
        /^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml))(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(
          url,
        );
      if (!match) throw new Error("Unsupported inline image format");
      const mimeType = match[1]!.toLowerCase().replace("image/jpg", "image/jpeg");
      const bytes = match[2]
        ? Uint8Array.from(atob(decodeURIComponent(match[3]!)), (char) => char.charCodeAt(0))
        : decodeDataUrlBytes(match[3]!);
      const svg = mimeType === "image/svg+xml";
      if (!svg && sniffImageMimeType(bytes) !== mimeType)
        throw new Error("Inline image data does not match its format");
      return this.addImageAsset(id, bytes, svg);
    } catch {
      this.warn("Some inline image fills are invalid or use an unsupported image format");
      return null;
    }
  }

  warnings(): string[] {
    return [...this.warningCounts].map(([message, count]) =>
      count > 1 ? `${message} (${count}x)` : message,
    );
  }

  result(name: string): CanvasImportResult {
    if (Object.values(this.nodes).some((node) => (node.backgroundBlur ?? 0) > 0)) {
      this.warn("Background blur is preserved for export but is not rendered on the canvas");
    }
    return {
      name,
      rootIds: this.rootIds,
      nodes: this.nodes as Record<string, CanvasNode>,
      assets: this.assets,
      warnings: this.warnings(),
    };
  }
}

/** Strips empty optional fields so nodes stay compact on the wire. */
export function compactNode<T extends Record<string, unknown>>(node: T): T {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete node[key];
  }
  return node;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const hexByte = (value: number) =>
  Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb` when opaque, `#rrggbbaa` otherwise. Channels are 0..1. */
export function rgbaToHex(r: number, g: number, b: number, a = 1): string {
  const base = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return clamp01(a) >= 0.999 ? base : `${base}${hexByte(a)}`;
}

/** Normalizes `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` to lowercase 6/8 digit hex, or null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1]!.toLowerCase();
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((char) => char + char).join("");
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  if (hex.length === 8 && hex.endsWith("ff")) hex = hex.slice(0, 6);
  return `#${hex}`;
}

function hexAlpha(hex: string): number {
  return hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
}

/** Multiplies a hex color's alpha by `alpha`. */
export function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex;
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return rgbaToHex(r, g, b, hexAlpha(hex) * alpha);
}

function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const [b0, b1, b2, b3] = [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "image/png";
  if (b0 === 0xff && b1 === 0xd8) return "image/jpeg";
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return "image/gif";
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46 && bytes[8] === 0x57) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Rounds geometry to 1/100 px so imports do not carry float noise. */
export const round2 = (value: number) => Math.round(value * 100) / 100;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** File name without directories or the last extension. */
export function baseName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/** Shifts top-level nodes so each source document sits to the right of the previous one. */
export function layoutSideBySide(builder: ImportBuilder, rootIds: ReadonlyArray<string>): void {
  let cursor = 0;
  for (const id of rootIds) {
    const node = builder.nodes[id];
    if (!node) continue;
    node.x = cursor;
    node.y = 0;
    cursor += node.width + SIDE_BY_SIDE_GAP;
  }
}

/**
 * Wraps the top-level nodes added since `firstRootIndex` in one frame sized
 * to their bounds, so one source document becomes one top-level frame.
 */
export function wrapRootsInFrame(
  builder: ImportBuilder,
  firstRootIndex: number,
  frame: Omit<DraftNode, "id" | "parentId" | "x" | "y" | "width" | "height">,
): DraftNode | null {
  const ids = builder.rootIds.splice(firstRootIndex);
  if (ids.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = builder.nodes[id]!;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  const wrapper = builder.add({ ...frame, x: 0, y: 0, width: 0, height: 0 }, null);
  wrapper.width = round2(maxX - minX);
  wrapper.height = round2(maxY - minY);
  wrapper.childIds = ids;
  for (const id of ids) {
    const node = builder.nodes[id]!;
    node.parentId = wrapper.id;
    node.x = round2(node.x - minX);
    node.y = round2(node.y - minY);
  }
  return wrapper;
}

function checkDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS
  ) {
    throw new Error(
      "Images must be at most 16384 px per side and 64 megapixels; resize the export first",
    );
  }
}

function svgLength(value: string | null): number | undefined {
  const match = value?.trim().match(/^([\d.+e-]+)(px|pt|pc|in|cm|mm)?$/i);
  if (!match) return undefined;
  const units: Record<string, number> = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
  };
  const result = Number(match[1]) * (units[match[2]?.toLowerCase() ?? "px"] ?? 1);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

const localReference = (value: string) =>
  /^#[^\s]*$/.test(value.trim()) ||
  /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(value.trim());

/** SVG remains an inert image: no scripts, HTML, animation, or external fetches. */
function sanitizeSvg(source: string, builder: ImportBuilder) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("SVG document types and entities are not supported");
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.localName !== "svg" || (root.namespaceURI && root.namespaceURI !== SVG_NS)) {
    throw new Error("The file does not contain an SVG document");
  }
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const validViewBox =
    viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0;
  let width = svgLength(root.getAttribute("width"));
  let height = svgLength(root.getAttribute("height"));
  if (validViewBox) {
    width ??= height ? (height * viewBox[2]!) / viewBox[3]! : viewBox[2]!;
    height ??= (width * viewBox[3]!) / viewBox[2]!;
  }
  width ??= 300;
  height ??= 150;
  checkDimensions(width, height);
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  const queue: Array<{ node: Element; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  let stripped = false;
  const unsafeCss = (value: string) =>
    /\\|@import|expression\s*\(/i.test(value) ||
    /url\s*\(/i.test(value.replace(/url\(\s*(?:"#[^"]*"|'#[^']*'|#[^\s)]*)\s*\)/gi, ""));
  while (queue.length > 0) {
    const { node, depth } = queue.pop()!;
    if (++visited > 100_000 || depth > 256)
      throw new Error("SVG exceeds the supported element or nesting limit");
    if (
      node !== root &&
      ((node.namespaceURI && node.namespaceURI !== SVG_NS) ||
        /^(script|foreignObject|animate|animateMotion|animateTransform|set|discard)$/i.test(
          node.localName ?? "",
        ))
    ) {
      node.parentNode?.removeChild(node);
      stripped = true;
      continue;
    }
    if (node.localName === "style" && unsafeCss(node.textContent ?? "")) {
      node.parentNode?.removeChild(node);
      stripped = true;
      continue;
    }
    for (let k = node.attributes.length - 1; k >= 0; k--) {
      const attribute = node.attributes.item(k)!;
      if (
        /^on/i.test(attribute.localName ?? "") ||
        attribute.localName === "base" ||
        ((attribute.localName === "href" || attribute.localName === "src") &&
          !localReference(attribute.value)) ||
        unsafeCss(attribute.value)
      ) {
        node.removeAttributeNode(attribute);
        stripped = true;
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) queue.push({ node: child as Element, depth: depth + 1 });
    }
  }
  if (stripped)
    builder.warn(
      "SVG scripts, animation, embedded HTML, or external resources were removed; embed images and outline fonts before exporting for a faithful static image",
    );
  return { source: new XMLSerializer().serializeToString(root), width, height };
}

/** Data URLs may percent-encode binary bytes without using base64. */
function decodeDataUrlBytes(source: string): Uint8Array {
  const encoded = new TextEncoder().encode(source);
  const bytes = new Uint8Array(encoded.length);
  let length = 0;
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] !== 0x25) {
      bytes[length++] = encoded[index]!;
      continue;
    }
    const hex = String.fromCharCode(encoded[index + 1] ?? 0, encoded[index + 2] ?? 0);
    if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("Invalid data URL encoding");
    bytes[length++] = Number.parseInt(hex, 16);
    index += 2;
  }
  return bytes.subarray(0, length);
}
