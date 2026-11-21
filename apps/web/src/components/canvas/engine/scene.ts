import type { CanvasDocument, CanvasNode, CanvasOp } from "@t3tools/contracts";

import { animationEndMs, sampleAnimation } from "./animation";
import { parseColor, premultiply } from "./color";
import {
  FLAG_ELLIPSE,
  FLAG_SCREEN,
  FLAG_TABLE,
  FLAG_TILE,
  KIND_FILL,
  KIND_INSET,
  KIND_SHADOW,
  KIND_STROKE,
  KIND_TEXT,
  KIND_TEXTURE,
  LAYER_SHIFT,
  NO_CLIP,
  PAINT_IMAGE,
  PAINT_LINEAR,
  PAINT_RADIAL,
  PAINT_SHIFT,
  STRIDE,
  CLIP_SIZE,
  W_CLIP,
  W_COLOR,
  W_EFFECT_ALPHA,
  W_FLAGS,
  W_PARAMS,
  W_UV,
} from "./format";
import { layoutChildren } from "./layout";
import { SpatialGrid } from "./spatialGrid";
import {
  bucketFor,
  lineHeightPx,
  linearGradientLine,
  type Ramp,
  type TexFamily,
  type TextureCache,
} from "./textures";

export const CHUNK = 256;
const WHITE = 0xffffffff;
const IMAGE_PLACEHOLDER = 0x22808080;
const SQRT2 = Math.SQRT2;
const ORDER_SPAN = 4194304;

interface Slot {
  node: CanvasNode | null;
  w: number;
  h: number;
  family: TexFamily | null;
}

interface AnimState {
  node: CanvasNode;
  starts: Float64Array;
  override: Record<string, unknown>;
  settled: boolean;
  /** Conservative local sweep for animated geometry, used before current-frame culling. */
  motionBounds: readonly [number, number, number, number] | null;
}

type MutableNode = { -readonly [K in keyof CanvasNode]: CanvasNode[K] };

function textured(node: CanvasNode): boolean {
  if (node.type === "text" || node.type === "path" || node.type === "line") return true;
  const fills = node.fills;
  if (!fills) return false;
  for (const fill of fills) if (fill.type === "image" || fill.type === "shader") return true;
  return false;
}

function countPrims(node: CanvasNode): number {
  switch (node.type) {
    case "group":
      return 0;
    case "text":
      return node.text ? 1 : 0;
    case "path":
    case "line":
      return (node.fills?.length ?? 0) + (node.strokes?.length ?? 0) > 0 ? 1 : 0;
    default:
      return (node.shadows?.length ?? 0) + (node.fills?.length ?? 0) + (node.strokes?.length ?? 0);
  }
}

const slack = (count: number) => Math.max(8, count >> 3);

/** Imported children marked `absolute` ignore their parent's auto layout. */
const isAbsolute = (node: CanvasNode) =>
  node.className !== undefined && /(?:^|\s)absolute(?:\s|$)/.test(node.className);

/**
 * Dense typed arrays encode layout, transforms, clips, and paint-order GPU instances.
 * Each top-level node owns a buffer segment with slack, so structural edits only rebuild
 * that subtree. Edits preserving tree shape update touched nodes in place.
 */
export class Scene {
  doc: CanvasDocument | null = null;
  private readonly idToIndex = new Map<string, number>();
  private ids: string[] = [];
  private nodes: Array<CanvasNode | undefined> = [];
  private freeList: number[] = [];
  private cap = 0;

  private parent = new Int32Array(0);
  private geom = new Float64Array(0);
  private world = new Float32Array(0);
  private aabb = new Float32Array(0);
  private alpha = new Float32Array(0);
  private clip = new Float32Array(0);
  private childClip = new Float32Array(0);
  private primStart = new Int32Array(0);
  private primCount = new Int32Array(0);
  private subtreeEnd = new Int32Array(0);
  private orderPos = new Int32Array(0);
  private rootOf = new Int32Array(0);
  private rootRank = new Int32Array(0);
  private segCap = new Int32Array(0);
  private isSegment = new Uint8Array(0);
  private locked = new Uint8Array(0);
  private visitStamp = new Uint32Array(0);
  private reencodeFlag = new Uint8Array(0);
  private texQueued = new Uint8Array(0);
  /** Nearest effect root at or above each node, or -1. */
  private effectOf = new Int32Array(0);
  /**
   * Outermost nodes drawn through an offscreen layer: frames with opacity < 1
   * (group opacity) and nodes with a layer blur. Their opacity is separate from
   * primitive colors so fallback draws batch and layers defer it to compositing.
   * Effects nested inside one fall back to per-primitive opacity and no blur.
   */
  private readonly effects = new Set<number>();
  private readonly shaderNodes = new Set<number>();
  private readonly visibleShaders = new Set<TexFamily>();
  private effectsDirty = true;
  private effectSpans = new Int32Array(0);
  private effectCount = 0;
  /**
   * Textured nodes waiting for a raster check: visited (edited) nodes plus
   * what texture passes found in view. Drained on a time budget.
   */
  private readonly texQueue: number[] = [];
  private texHead = 0;
  /** Rect and scale of the latest texture pass; scale 0 forces a full pass. */
  private readonly lastPass = new Float64Array(5);
  /** Rect and scale queued nodes are checked against. */
  private readonly passView = new Float64Array(5);
  private incrementalPasses = 0;
  private stampValue = 1;
  private slots: Array<Slot[] | undefined> = [];
  private anim: Array<AnimState | undefined> = [];
  private animFill = new Float64Array(0);
  private animScale = new Float32Array(0);

  // Instances.
  f32 = new Float32Array(0);
  private u32 = new Uint32Array(0);
  private instAabb = new Float32Array(0);
  /** High-water mark of the instance buffer (segments plus slack and garbage). */
  instCount = 0;
  private instCap = 0;
  /** Instances the CPU buffer holds; the GPU buffer reserves as much. */
  get instanceCapacity() {
    return this.instCap;
  }
  private garbage = 0;
  private chunkAabb = new Float32Array(0);
  chunkDirty = new Uint8Array(0);
  chunkCount = 0;
  fullUpload = true;
  private rootList: number[] = [];

  private readonly grid = new SpatialGrid();
  private readonly textureGrid = new SpatialGrid();
  private readonly animated = new Set<number>();
  /** Texture re-encodes: new arrivals, then in-view work, then the rest. */
  private readonly reencodeIncoming: number[] = [];
  private readonly reencodeFront: number[] = [];
  private frontHead = 0;
  private readonly reencodeList: number[] = [];
  private reencodeHead = 0;
  private rebuilding = false;
  /** Top-level ids of a new document not yet encoded. */
  private buildQueue: string[] = [];
  private buildPos = 0;
  private order = 0;
  private cursor = 0;
  private currentRoot = -1;
  private playing = false;
  private playStart = 0;
  private pausedAt: number | null = null;
  private readonly animationViewBounds = new Float64Array(4);
  private readonly matrix = new Float64Array(6);
  private readonly radiiScratch = new Float64Array(4);

  // Overlay (hover + selection outlines).
  overlayF32 = new Float32Array(STRIDE * 16);
  private overlayU32 = new Uint32Array(this.overlayF32.buffer);
  overlayCount = 0;

  constructor(private readonly textures: TextureCache) {}

  private grow(min: number) {
    if (min <= this.cap) return;
    const cap = Math.max(min, this.cap * 2, 1024);
    const resize = <
      T extends Float64Array | Float32Array | Int32Array | Int8Array | Uint8Array | Uint32Array,
    >(
      array: T,
      per: number,
      make: (size: number) => T,
    ): T => {
      const next = make(cap * per);
      next.set(array);
      return next;
    };
    this.parent = resize(this.parent, 1, (n) => new Int32Array(n));
    this.geom = resize(this.geom, 4, (n) => new Float64Array(n));
    this.world = resize(this.world, 6, (n) => new Float32Array(n));
    this.aabb = resize(this.aabb, 4, (n) => new Float32Array(n));
    this.alpha = resize(this.alpha, 1, (n) => new Float32Array(n));
    this.clip = resize(this.clip, CLIP_SIZE, (n) => new Float32Array(n));
    this.childClip = resize(this.childClip, CLIP_SIZE, (n) => new Float32Array(n));
    this.primStart = resize(this.primStart, 1, (n) => new Int32Array(n));
    this.primCount = resize(this.primCount, 1, (n) => new Int32Array(n));
    this.subtreeEnd = resize(this.subtreeEnd, 1, (n) => new Int32Array(n));
    this.orderPos = resize(this.orderPos, 1, (n) => new Int32Array(n).fill(-1));
    this.rootOf = resize(this.rootOf, 1, (n) => new Int32Array(n));
    this.rootRank = resize(this.rootRank, 1, (n) => new Int32Array(n));
    this.segCap = resize(this.segCap, 1, (n) => new Int32Array(n));
    this.isSegment = resize(this.isSegment, 1, (n) => new Uint8Array(n));
    this.locked = resize(this.locked, 1, (n) => new Uint8Array(n));
    this.visitStamp = resize(this.visitStamp, 1, (n) => new Uint32Array(n));
    this.reencodeFlag = resize(this.reencodeFlag, 1, (n) => new Uint8Array(n));
    this.texQueued = resize(this.texQueued, 1, (n) => new Uint8Array(n));
    this.effectOf = resize(this.effectOf, 1, (n) => new Int32Array(n).fill(-1));
    this.animFill = resize(this.animFill, 1, (n) => new Float64Array(n).fill(Number.NaN));
    this.animScale = resize(this.animScale, 1, (n) => new Float32Array(n).fill(1));
    this.cap = cap;
    this.grid.reserve(cap);
  }

  private alloc(id: string): number {
    let index = this.idToIndex.get(id);
    if (index !== undefined) return index;
    index = this.freeList.pop() ?? this.ids.length;
    this.grow(index + 1);
    this.idToIndex.set(id, index);
    this.ids[index] = id;
    this.orderPos[index] = -1;
    this.isSegment[index] = 0;
    return index;
  }

  private release(index: number) {
    this.idToIndex.delete(this.ids[index]!);
    this.nodes[index] = undefined;
    this.orderPos[index] = -1;
    this.isSegment[index] = 0;
    this.grid.remove(index);
    this.textureGrid.remove(index);
    const slots = this.slots[index];
    if (slots) for (const slot of slots) slot.family?.users.delete(index);
    this.slots[index] = undefined;
    this.anim[index] = undefined;
    this.animated.delete(index);
    this.animFill[index] = Number.NaN;
    this.animScale[index] = 1;
    if (this.effects.delete(index)) this.effectsDirty = true;
    this.shaderNodes.delete(index);
    this.effectOf[index] = -1;
    this.freeList.push(index);
  }

  private ensureInstances(count: number) {
    if (count <= this.instCap) return;
    const cap = Math.max(count, Math.ceil(this.instCap * 1.5), 4096);
    const f32 = new Float32Array(cap * STRIDE);
    f32.set(this.f32);
    this.f32 = f32;
    this.u32 = new Uint32Array(f32.buffer);
    const aabb = new Float32Array(cap * 4);
    aabb.set(this.instAabb);
    this.instAabb = aabb;
    this.instCap = cap;
  }

  private ensureChunks() {
    const count = Math.ceil(this.instCount / CHUNK);
    if (this.chunkDirty.length < count) {
      const size = Math.max(count * 2, 64);
      const aabb = new Float32Array(size * 4);
      aabb.set(this.chunkAabb);
      this.chunkAabb = aabb;
      const dirty = new Uint8Array(size);
      dirty.set(this.chunkDirty);
      this.chunkDirty = dirty;
    }
    for (let chunk = this.chunkCount; chunk < count; chunk++) this.chunkDirty[chunk] = 1;
    this.chunkCount = count;
  }

  private markDirty(from: number, to: number) {
    if (to <= from) return;
    const last = ((to - 1) / CHUNK) | 0;
    for (let chunk = (from / CHUNK) | 0; chunk <= last; chunk++) this.chunkDirty[chunk] = 1;
  }

  /** Turns instances [from, to) into zero-area quads the vertex shader drops. */
  private emptyRange(from: number, to: number) {
    const f = this.f32;
    const u = this.u32;
    const aabb = this.instAabb;
    for (let k = from; k < to; k++) {
      const base = k * STRIDE;
      f[base + 8] = 0;
      f[base + 9] = 0;
      u[base + W_FLAGS] = 0;
      const o = k * 4;
      aabb[o] = Infinity;
      aabb[o + 1] = Infinity;
      aabb[o + 2] = -Infinity;
      aabb[o + 3] = -Infinity;
    }
    this.markDirty(from, to);
  }

  /**
   * A new document starts a progressive build (see `continueBuild`); a new
   * version of the current one is diffed. Pass the op batch that produced
   * `doc` to skip the O(n) identity scan.
   */
  setDocument(doc: CanvasDocument, ops?: ReadonlyArray<CanvasOp>): void {
    const prev = this.doc;
    if (prev === doc) return;
    if (this.building) {
      if (prev && prev.id === doc.id) this.continueBuild(Infinity);
      this.buildQueue = [];
      this.buildPos = 0;
    }
    this.doc = doc;
    this.textures.syncAssets(doc.assets);
    if (!prev || prev.id !== doc.id) {
      for (let index = 0; index < this.ids.length; index++) {
        if (this.idToIndex.get(this.ids[index]!) === index) this.release(index);
      }
      this.idToIndex.clear();
      this.ids = [];
      this.nodes = [];
      this.freeList = [];
      this.startBuild();
      return;
    }
    const affected = new Set<string>();
    const changed: number[] = [];
    const touch = (id: string) => {
      const root = this.rootIdFor(id, doc, prev);
      if (root !== null) affected.add(root);
    };
    const consider = (id: string) => {
      const node = doc.nodes[id];
      const index = this.idToIndex.get(id);
      if (index === undefined || this.orderPos[index]! < 0) {
        if (node && node.visible !== false) touch(id);
        return;
      }
      if (!node) {
        touch(id);
        return;
      }
      const old = this.nodes[index]!;
      if (old === node) return;
      if (
        old.childIds !== node.childIds ||
        old.parentId !== node.parentId ||
        old.visible !== node.visible ||
        countPrims(old) !== countPrims(node)
      ) {
        touch(id);
        if (node.parentId !== null && node.parentId !== old.parentId) touch(node.parentId);
        return;
      }
      changed.push(index);
    };
    if (ops) {
      for (const op of ops) {
        switch (op.op) {
          case "update":
            consider(op.id);
            break;
          case "insert":
            if (op.node.parentId !== null) touch(op.node.parentId);
            break;
          case "delete":
            touch(op.id);
            break;
          case "move":
            touch(op.id);
            if (op.parentId !== null) touch(op.parentId);
            break;
          default:
            break;
        }
      }
    } else {
      const prevNodes = prev.nodes;
      for (const id in doc.nodes) {
        if (prevNodes[id] !== doc.nodes[id]) consider(id);
      }
    }
    this.stampValue = (this.stampValue + 1) >>> 0 || 1;
    if (affected.size > 0 || doc.rootIds !== prev.rootIds) this.structuralUpdate(affected);
    for (const index of changed) {
      // Rebuilt segments already re-encoded these.
      if (this.visitStamp[index] === this.stampValue || this.nodes[index] === undefined) continue;
      const node = doc.nodes[this.ids[index]!]!;
      this.nodes[index] = node;
      if (node.animations?.length || this.anim[index]) this.syncAnimation(index, node);
    }
    const roots = new Set<number>();
    for (const index of changed) {
      if (this.visitStamp[index] === this.stampValue || this.nodes[index] === undefined) continue;
      const parent = this.parent[index]!;
      roots.add(parent >= 0 && this.nodes[parent]!.layout ? parent : index);
    }
    for (const root of roots) this.updateSubtree(root);
  }

  /** Id of the drawn top-level node containing `id` (new or old tree), or null. */
  private rootIdFor(id: string, doc: CanvasDocument, prev: CanvasDocument): string | null {
    let current: string | null = id;
    for (let guard = 0; current !== null && guard < 10_000; guard++) {
      const index = this.idToIndex.get(current);
      if (index !== undefined && this.orderPos[index]! >= 0) return this.ids[this.rootOf[index]!]!;
      const node: CanvasNode | undefined = doc.nodes[current] ?? prev.nodes[current];
      if (!node) return null;
      current = node.parentId;
    }
    return null;
  }

  /**
   * Sizes the grids from a sample of `doc.nodes` and estimates node and
   * primitive counts without reading every node (the build grows past an
   * underestimate).
   */
  private scanDocument(doc: CanvasDocument): { nodes: number; prims: number } {
    const ids = Object.keys(doc.nodes);
    const nodes = ids.length;
    const step = Math.max(1, Math.floor(nodes / 2048));
    const sizes: number[] = [];
    let sampled = 0;
    for (let k = 0; k < nodes; k += step) {
      const node = doc.nodes[ids[k]!]!;
      sampled += countPrims(node);
      sizes.push(Math.max(node.width, node.height));
    }
    const prims = Math.ceil((sampled / Math.max(1, sizes.length)) * nodes * 1.1);
    sizes.sort((a, b) => a - b);
    const median = sizes[sizes.length >> 1] ?? 256;
    const cell = 2 ** Math.round(Math.log2(Math.max(32, Math.min(8192, median * 2))));
    this.grid.reset(cell);
    this.textureGrid.reset(cell);
    return { nodes, prims };
  }

  /** True while a new document is still being encoded. */
  get building() {
    return this.buildPos < this.buildQueue.length;
  }

  /**
   * Prepares an empty scene for a new document; `continueBuild` then encodes
   * top-level subtrees a time slice at a time. A single subtree is atomic;
   * documents with multiple roots show up progressively in paint order.
   */
  private startBuild() {
    const doc = this.doc!;
    this.stampValue = (this.stampValue + 1) >>> 0 || 1;
    for (const root of this.rootList) this.isSegment[root] = 0;
    this.instCount = 0;
    this.garbage = 0;
    this.chunkCount = 0;
    // Size buffers once instead of growing through the encode.
    const { nodes, prims } = this.scanDocument(doc);
    this.grow(nodes);
    this.ensureInstances(prims + slack(prims) + doc.rootIds.length * 8);
    this.rootList = [];
    this.buildQueue = this.drawnRootIds(doc);
    this.buildPos = 0;
    this.fullUpload = true;
    this.invalidateTexturePass();
  }

  /**
   * Encodes queued top-level subtrees within `budgetMs` (at least one), stopping
   * early when the next subtree would likely overrun it.
   */
  continueBuild(budgetMs: number) {
    const queue = this.buildQueue;
    if (this.buildPos >= queue.length) return;
    const start = performance.now();
    let last = start;
    let cost = 0;
    while (this.buildPos < queue.length) {
      this.rootList.push(this.buildRoot(queue[this.buildPos++]!, true));
      const now = performance.now();
      cost = Math.max(cost * 0.5, now - last);
      last = now;
      if (now - start + cost > budgetMs) break;
    }
    this.rankRoots();
    this.ensureChunks();
    if (this.buildPos >= queue.length) {
      this.buildQueue = [];
      this.buildPos = 0;
    }
  }

  /**
   * Union of top-level node boxes from the document itself (rotation-aware,
   * no shadows): the fit target while a build is still running.
   */
  rootBounds(): [number, number, number, number] | null {
    const doc = this.doc;
    if (!doc) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of this.drawnRootIds(doc)) {
      const node = doc.nodes[id]!;
      const radians = ((node.rotation ?? 0) * Math.PI) / 180;
      const hw =
        (Math.abs(Math.cos(radians)) * node.width + Math.abs(Math.sin(radians)) * node.height) / 2;
      const hh =
        (Math.abs(Math.sin(radians)) * node.width + Math.abs(Math.cos(radians)) * node.height) / 2;
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      x0 = Math.min(x0, cx - hw);
      y0 = Math.min(y0, cy - hh);
      x1 = Math.max(x1, cx + hw);
      y1 = Math.max(y1, cy + hh);
    }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
  }

  private drawnRootIds(doc: CanvasDocument): string[] {
    return doc.rootIds.filter((id) => {
      const node = doc.nodes[id];
      return node !== undefined && node.visible !== false;
    });
  }

  /** Lays out every top-level segment back to back and drops everything else. */
  private fullRebuild() {
    const doc = this.doc!;
    this.stampValue = (this.stampValue + 1) >>> 0 || 1;
    for (const root of this.rootList) this.isSegment[root] = 0;
    this.instCount = 0;
    this.garbage = 0;
    this.chunkCount = 0;
    // Size buffers once instead of growing through the encode.
    let nodes = 0;
    let prims = 0;
    for (const id in doc.nodes) {
      nodes++;
      prims += countPrims(doc.nodes[id]!);
    }
    this.grow(nodes);
    this.ensureInstances(prims + slack(prims) + doc.rootIds.length * 8);
    // The next texture pass scans the whole view, so nothing needs queueing here.
    this.rebuilding = true;
    this.rootList = this.drawnRootIds(doc).map((id) => this.buildRoot(id, true));
    this.rebuilding = false;
    this.invalidateTexturePass();
    const stamp = this.stampValue;
    for (let index = 0; index < this.ids.length; index++) {
      if (this.visitStamp[index] === stamp) continue;
      if (this.idToIndex.get(this.ids[index]!) !== index) continue;
      this.release(index);
    }
    this.rankRoots();
    this.ensureChunks();
    this.chunkDirty.fill(1, 0, this.chunkCount);
    this.refreshDirtyChunks();
    this.chunkDirty.fill(0);
    this.fullUpload = true;
  }

  private structuralUpdate(affected: ReadonlySet<string>) {
    const doc = this.doc!;
    const newRoots = this.drawnRootIds(doc);
    const newSet = new Set(newRoots);
    const candidates: number[] = [];
    // Collect old subtrees first, while `nodes` still holds the previous tree.
    for (const root of this.rootList) {
      const id = this.ids[root]!;
      const stillRoot = newSet.has(id) && doc.nodes[id]!.parentId === null;
      if (!stillRoot) {
        this.collect(root, candidates);
        this.freeSegment(root);
      } else if (affected.has(id)) {
        this.collect(root, candidates);
      }
    }
    const rootList: number[] = [];
    for (const id of newRoots) {
      const index = this.idToIndex.get(id);
      if (index === undefined || this.isSegment[index] !== 1 || affected.has(id)) {
        rootList.push(this.buildRoot(id));
      } else {
        rootList.push(index);
      }
    }
    const stamp = this.stampValue;
    for (const index of candidates) {
      if (this.visitStamp[index] === stamp) continue;
      if (this.idToIndex.get(this.ids[index]!) !== index) continue;
      this.release(index);
    }
    this.rootList = rootList;
    this.rankRoots();
    this.ensureChunks();
    if (this.garbage > this.instCount / 2 && this.instCount > 4096) this.fullRebuild();
  }

  private collect(root: number, out: number[]) {
    const stack = [root];
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (this.orderPos[index]! < 0) continue;
      out.push(index);
      const childIds = this.nodes[index]?.childIds;
      if (!childIds) continue;
      for (const id of childIds) {
        const child = this.idToIndex.get(id);
        if (child !== undefined) stack.push(child);
      }
    }
  }

  private freeSegment(root: number) {
    if (this.isSegment[root] !== 1) return;
    const start = this.primStart[root]!;
    this.emptyRange(start, start + this.segCap[root]!);
    this.garbage += this.segCap[root]!;
    this.isSegment[root] = 0;
  }

  private countSubtree(id: string): number {
    const doc = this.doc!;
    const node = doc.nodes[id];
    if (!node || node.visible === false) return 0;
    let count = countPrims(node);
    if (node.childIds) for (const child of node.childIds) count += this.countSubtree(child);
    return count;
  }

  /** (Re)encodes one top-level subtree into its segment, relocating it if it outgrew its slack. */
  private buildRoot(id: string, append = false): number {
    const doc = this.doc!;
    const node = doc.nodes[id]!;
    const index = this.alloc(id);
    let start: number;
    let cap: number;
    // Appending (full rebuild) sizes the segment after encoding; otherwise count first
    // to decide whether the subtree still fits its old segment.
    const count = append ? -1 : this.countSubtree(id);
    if (!append && this.isSegment[index] === 1 && count <= this.segCap[index]!) {
      start = this.primStart[index]!;
      cap = this.segCap[index]!;
    } else {
      this.freeSegment(index);
      start = this.instCount;
      cap = append ? -1 : count + slack(count);
    }
    this.nodes[index] = node;
    this.parent[index] = -1;
    this.isSegment[index] = 1;
    this.setGeomFromNode(index, this.effective(index));
    this.cursor = start;
    this.order = 0;
    this.currentRoot = index;
    this.visit(index, true);
    if (cap < 0) cap = this.cursor - start + slack(this.cursor - start);
    if (start + cap > this.instCount) {
      this.instCount = start + cap;
      this.ensureInstances(this.instCount);
      this.ensureChunks();
    }
    this.segCap[index] = cap;
    this.emptyRange(this.cursor, start + cap);
    this.markDirty(start, start + cap);
    return index;
  }

  private rankRoots() {
    for (let rank = 0; rank < this.rootList.length; rank++) {
      this.rootRank[this.rootList[rank]!] = rank;
    }
  }

  private setGeomFromNode(index: number, node: CanvasNode) {
    const base = index * 4;
    this.geom[base] = node.x;
    this.geom[base + 1] = node.y;
    this.geom[base + 2] = node.width;
    this.geom[base + 3] = node.height;
  }

  private effective(index: number): CanvasNode {
    const state = this.anim[index];
    return state ? (state.override as CanvasNode) : this.nodes[index]!;
  }

  /** Recomputes geometry and re-encodes a subtree whose shape did not change. */
  private updateSubtree(index: number) {
    if (this.orderPos[index]! < 0) return;
    const parent = this.parent[index]!;
    if (parent < 0 || !this.nodes[parent]!.layout) {
      this.setGeomFromNode(index, this.effective(index));
    }
    this.visit(index, false);
  }

  private visit(index: number, rebuild: boolean) {
    const node = this.effective(index);
    if (node.fills?.some((fill) => fill.type === "shader")) this.shaderNodes.add(index);
    else this.shaderNodes.delete(index);
    const parent = this.parent[index]!;
    const g = index * 4;
    const x = this.geom[g]!;
    const y = this.geom[g + 1]!;
    const w = this.geom[g + 2]!;
    const h = this.geom[g + 3]!;

    // World matrix: parent * translate(center) * rotate * scale * translate(-half).
    const rotation = node.rotation ?? 0;
    const scale = this.animScale[index]!;
    let cos = scale;
    let sin = 0;
    if (rotation !== 0) {
      const radians = (rotation * Math.PI) / 180;
      cos = Math.cos(radians) * scale;
      sin = Math.sin(radians) * scale;
    }
    const m = this.matrix;
    m[0] = cos;
    m[1] = sin;
    m[2] = -sin;
    m[3] = cos;
    m[4] = x + w / 2 - (cos * w) / 2 + (sin * h) / 2;
    m[5] = y + h / 2 - (sin * w) / 2 - (cos * h) / 2;
    const wo = index * 6;
    const world = this.world;
    const c = index * CLIP_SIZE;
    const opacity = node.opacity ?? 1;
    const outerEffect = parent >= 0 ? this.effectOf[parent]! : -1;
    const kids = this.nodes[index]!.childIds;
    const effect =
      outerEffect < 0 &&
      ((opacity < 1 && kids !== undefined && kids.length > 0) || (node.layerBlur ?? 0) > 0);
    this.effectOf[index] = effect ? index : outerEffect;
    if (effect) {
      this.effects.add(index);
      this.effectsDirty = true;
    } else if (this.effects.delete(index)) this.effectsDirty = true;
    const ownAlpha = effect ? 1 : opacity;
    if (parent >= 0) {
      const po = parent * 6;
      const pa = world[po]!;
      const pb = world[po + 1]!;
      const pc = world[po + 2]!;
      const pd = world[po + 3]!;
      world[wo] = pa * m[0] + pc * m[1];
      world[wo + 1] = pb * m[0] + pd * m[1];
      world[wo + 2] = pa * m[2] + pc * m[3];
      world[wo + 3] = pb * m[2] + pd * m[3];
      world[wo + 4] = pa * m[4] + pc * m[5] + world[po + 4]!;
      world[wo + 5] = pb * m[4] + pd * m[5] + world[po + 5]!;
      this.alpha[index] = this.alpha[parent]! * ownAlpha;
      this.locked[index] = this.locked[parent]! | (node.locked === true ? 1 : 0);
      for (let k = 0; k < CLIP_SIZE; k++)
        this.clip[c + k] = this.childClip[parent * CLIP_SIZE + k]!;
    } else {
      world[wo] = m[0];
      world[wo + 1] = m[1];
      world[wo + 2] = m[2];
      world[wo + 3] = m[3];
      world[wo + 4] = m[4];
      world[wo + 5] = m[5];
      this.alpha[index] = ownAlpha;
      this.locked[index] = node.locked === true ? 1 : 0;
      this.clip[c] = 0;
      this.clip[c + 1] = 0;
      this.clip[c + 2] = NO_CLIP;
      this.clip[c + 3] = NO_CLIP;
      this.clip[c + 4] = 1;
      this.clip[c + 5] = 0;
      this.clip[c + 6] = 0;
    }
    const ab = index * 4;
    this.boxAabb(index, 0, 0, w, h, this.aabb, ab);
    if (node.clipContent === true) this.clipChildren(index, node, w, h);
    else for (let k = 0; k < CLIP_SIZE; k++) this.childClip[c + k] = this.clip[c + k]!;

    this.visitStamp[index] = this.stampValue;
    if (rebuild) {
      this.rootOf[index] = this.currentRoot;
      this.orderPos[index] = this.order++;
      this.primStart[index] = this.cursor;
      const count = countPrims(node);
      this.primCount[index] = count;
      this.cursor += count;
      if (this.cursor > this.instCap) this.ensureInstances(this.cursor);
      if (node.animations?.length || this.anim[index])
        this.syncAnimation(index, this.nodes[index]!);
    }
    this.encodeNode(index, node);
    const x0 = this.aabb[ab]!;
    const y0 = this.aabb[ab + 1]!;
    const x1 = this.aabb[ab + 2]!;
    const y1 = this.aabb[ab + 3]!;
    this.grid.update(index, x0, y0, x1, y1);
    if (textured(node)) {
      this.textureGrid.update(index, x0, y0, x1, y1);
      if (!this.rebuilding) this.enqueueTex(index);
    } else {
      this.textureGrid.remove(index);
    }

    const childIds = this.nodes[index]!.childIds;
    if (childIds && childIds.length > 0) {
      const doc = this.doc!;
      const layout = node.layout;
      // Children in paint order, and the subset auto layout positions.
      const children: number[] | null = layout ? [] : null;
      const flow: number[] | null = layout ? [] : null;
      for (const id of childIds) {
        let child: number;
        if (rebuild) {
          const childNode = doc.nodes[id];
          if (!childNode || childNode.visible === false) continue;
          child = this.alloc(id);
          this.nodes[child] = childNode;
          this.parent[child] = index;
        } else {
          child = this.idToIndex.get(id) ?? -1;
          if (child < 0 || this.orderPos[child]! < 0) continue;
        }
        const childNode = this.effective(child);
        this.setGeomFromNode(child, childNode);
        if (!children) this.visit(child, rebuild);
        else {
          children.push(child);
          if (!isAbsolute(childNode)) flow!.push(child);
        }
      }
      if (layout && children) {
        layoutChildren(layout, w, h, flow!, flow!.length, this.geom);
        for (const child of children) this.visit(child, rebuild);
      }
    }
    if (rebuild) this.subtreeEnd[index] = this.cursor;
  }

  /**
   * Clip for a frame's children: its own oriented rounded rect, intersected
   * with the inherited clip when both are axis-aligned. With rotation in play
   * only the innermost clip is kept.
   */
  private clipChildren(index: number, node: CanvasNode, w: number, h: number) {
    const wo = index * 6;
    const world = this.world;
    const a = world[wo]!;
    const b = world[wo + 1]!;
    const scale = Math.hypot(a, b) || 1e-9;
    let cos = a / scale;
    let sin = b / scale;
    const cx = a * (w / 2) + world[wo + 2]! * (h / 2) + world[wo + 4]!;
    const cy = b * (w / 2) + world[wo + 3]! * (h / 2) + world[wo + 5]!;
    let hx = (w * scale) / 2;
    let hy = (h * scale) / 2;
    let radius = node.type === "ellipse" ? Math.min(hx, hy) : uniformRadius(node, w, h) * scale;
    const c = index * CLIP_SIZE;
    const parent = this.clip;
    if (Math.abs(sin) < 1e-6) {
      // Axis aligned: a 180 degree turn is the same rect.
      cos = 1;
      sin = 0;
    }
    if (parent[c + 2]! < NO_CLIP && sin === 0 && Math.abs(parent[c + 5]!) < 1e-6) {
      const x0 = Math.max(parent[c]! - parent[c + 2]!, cx - hx);
      const y0 = Math.max(parent[c + 1]! - parent[c + 3]!, cy - hy);
      const x1 = Math.max(x0, Math.min(parent[c]! + parent[c + 2]!, cx + hx));
      const y1 = Math.max(y0, Math.min(parent[c + 1]! + parent[c + 3]!, cy + hy));
      const inside = x0 === cx - hx && y0 === cy - hy && x1 === cx + hx && y1 === cy + hy;
      if (!inside) {
        const parentInside =
          x0 === parent[c]! - parent[c + 2]! &&
          y0 === parent[c + 1]! - parent[c + 3]! &&
          x1 === parent[c]! + parent[c + 2]! &&
          y1 === parent[c + 1]! + parent[c + 3]!;
        radius = parentInside ? parent[c + 6]! : 0;
      }
      hx = (x1 - x0) / 2;
      hy = (y1 - y0) / 2;
      const out = this.childClip;
      out[c] = x0 + hx;
      out[c + 1] = y0 + hy;
      out[c + 2] = hx;
      out[c + 3] = hy;
      out[c + 4] = 1;
      out[c + 5] = 0;
      out[c + 6] = radius;
      return;
    }
    const out = this.childClip;
    out[c] = cx;
    out[c + 1] = cy;
    out[c + 2] = hx;
    out[c + 3] = hy;
    out[c + 4] = cos;
    out[c + 5] = sin;
    out[c + 6] = radius;
  }

  private boxAabb(
    index: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    out: Float32Array,
    at: number,
  ) {
    const wo = index * 6;
    const world = this.world;
    const a = world[wo]!;
    const b = world[wo + 1]!;
    const c = world[wo + 2]!;
    const d = world[wo + 3]!;
    const tx = world[wo + 4]!;
    const ty = world[wo + 5]!;
    const ax0 = a * x0;
    const ax1 = a * x1;
    const cy0 = c * y0;
    const cy1 = c * y1;
    const bx0 = b * x0;
    const bx1 = b * x1;
    const dy0 = d * y0;
    const dy1 = d * y1;
    out[at] = Math.min(ax0, ax1) + Math.min(cy0, cy1) + tx;
    out[at + 2] = Math.max(ax0, ax1) + Math.max(cy0, cy1) + tx;
    out[at + 1] = Math.min(bx0, bx1) + Math.min(dy0, dy1) + ty;
    out[at + 3] = Math.max(bx0, bx1) + Math.max(dy0, dy1) + ty;
  }

  private computeChunk(chunk: number) {
    const from = chunk * CHUNK;
    const to = Math.min(this.instCount, from + CHUNK);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const aabb = this.instAabb;
    for (let k = from; k < to; k++) {
      const o = k * 4;
      if (aabb[o]! < x0) x0 = aabb[o]!;
      if (aabb[o + 1]! < y0) y0 = aabb[o + 1]!;
      if (aabb[o + 2]! > x1) x1 = aabb[o + 2]!;
      if (aabb[o + 3]! > y1) y1 = aabb[o + 3]!;
    }
    const o = chunk * 4;
    this.chunkAabb[o] = x0;
    this.chunkAabb[o + 1] = y0;
    this.chunkAabb[o + 2] = x1;
    this.chunkAabb[o + 3] = y1;
  }

  /** Recomputes bounds of chunks written since the last upload. */
  refreshDirtyChunks() {
    for (let chunk = 0; chunk < this.chunkCount; chunk++) {
      if (this.chunkDirty[chunk] === 1) this.computeChunk(chunk);
    }
  }

  /**
   * Writes draw ranges `[start, end)` for chunks intersecting the world rect,
   * in paint order (top-level nodes in document order). Returns the count.
   */
  cull(x0: number, y0: number, x1: number, y1: number, out: { ranges: Int32Array }): number {
    const aabb = this.chunkAabb;
    let ranges = out.ranges;
    let count = 0;
    let lastEnd = -1;
    let lastRangeRoot = -1;
    let prevRoot = -1;
    let prevSegEnd = -1;
    for (const root of this.rootList) {
      const start = this.primStart[root]!;
      const end = this.subtreeEnd[root]!;
      const segStart = start;
      // Merging across a small gap is safe when the gap only holds this segment or the
      // directly preceding one, which keeps paint order (culled quads cost one vertex pass).
      const mergeable = lastRangeRoot === prevRoot && prevSegEnd === segStart;
      prevRoot = root;
      prevSegEnd = segStart + this.segCap[root]!;
      if (end <= start) continue;
      const first = (start / CHUNK) | 0;
      const last = ((end - 1) / CHUNK) | 0;
      let open = -1;
      for (let chunk = first; chunk <= last + 1; chunk++) {
        const o = chunk * 4;
        if (
          chunk <= last &&
          aabb[o]! <= x1 &&
          aabb[o + 2]! >= x0 &&
          aabb[o + 1]! <= y1 &&
          aabb[o + 3]! >= y0
        ) {
          if (open < 0) open = chunk;
          continue;
        }
        if (open < 0) continue;
        const rangeStart = Math.max(start, open * CHUNK);
        const rangeEnd = Math.min(end, chunk * CHUNK);
        open = -1;
        if (
          count > 0 &&
          rangeStart >= lastEnd &&
          rangeStart - lastEnd <= CHUNK * 2 &&
          (lastRangeRoot === root || mergeable)
        ) {
          ranges[count * 2 - 1] = rangeEnd;
        } else {
          if (count * 2 + 2 > ranges.length) {
            const next = new Int32Array(ranges.length * 2);
            next.set(ranges);
            ranges = next;
            out.ranges = next;
          }
          ranges[count * 2] = rangeStart;
          ranges[count * 2 + 1] = rangeEnd;
          count++;
        }
        lastEnd = rangeEnd;
        lastRangeRoot = root;
      }
    }
    return count;
  }

  private header(off: number, index: number, kind: number, flags: number, color: number) {
    const f = this.f32;
    const base = off * STRIDE;
    const wo = index * 6;
    const world = this.world;
    f[base] = world[wo]!;
    f[base + 1] = world[wo + 1]!;
    f[base + 2] = world[wo + 2]!;
    f[base + 3] = world[wo + 3]!;
    f[base + 4] = world[wo + 4]!;
    f[base + 5] = world[wo + 5]!;
    const c = index * CLIP_SIZE;
    for (let k = 0; k < CLIP_SIZE; k++) f[base + W_CLIP + k] = this.clip[c + k]!;
    this.u32[base + W_COLOR] = color;
    this.u32[base + W_FLAGS] = kind | flags;
    const effect = this.effectOf[index]!;
    f[base + W_EFFECT_ALPHA] = effect >= 0 ? this.effectOpacity(effect) : 1;
    return base;
  }

  private rect(base: number, x: number, y: number, w: number, h: number) {
    const f = this.f32;
    f[base + 6] = x;
    f[base + 7] = y;
    f[base + 8] = w;
    f[base + 9] = h;
  }

  private radii(base: number, r: Float64Array, grow: number) {
    const f = this.f32;
    f[base + 10] = r[0]! > 0 ? Math.max(0, r[0]! + grow) : 0;
    f[base + 11] = r[1]! > 0 ? Math.max(0, r[1]! + grow) : 0;
    f[base + 12] = r[2]! > 0 ? Math.max(0, r[2]! + grow) : 0;
    f[base + 13] = r[3]! > 0 ? Math.max(0, r[3]! + grow) : 0;
  }

  private params(base: number, a: number, b: number, c: number, d: number) {
    const f = this.f32;
    f[base + W_PARAMS] = a;
    f[base + W_PARAMS + 1] = b;
    f[base + W_PARAMS + 2] = c;
    f[base + W_PARAMS + 3] = d;
  }

  private uv(base: number, u0: number, v0: number, u1: number, v1: number) {
    const f = this.f32;
    f[base + W_UV] = u0;
    f[base + W_UV + 1] = v0;
    f[base + W_UV + 2] = u1;
    f[base + W_UV + 3] = v1;
  }

  private bound(off: number, index: number, x0: number, y0: number, x1: number, y1: number) {
    this.boxAabb(index, x0, y0, x1, y1, this.instAabb, off * 4);
  }

  private encodeNode(index: number, node: CanvasNode) {
    const count = this.primCount[index]!;
    if (count === 0) return;
    let off = this.primStart[index]!;
    this.markDirty(off, off + count);
    const g = index * 4;
    const w = this.geom[g + 2]!;
    const h = this.geom[g + 3]!;
    const alpha = this.alpha[index]!;

    if (node.type === "text") {
      this.encodeText(off, index, node, w, h, alpha);
      return;
    }
    if (node.type === "path" || node.type === "line") {
      const family = this.slots[index]?.[0]?.family ?? null;
      const base = this.header(
        off,
        index,
        KIND_TEXTURE,
        family ? FLAG_TABLE : 0,
        premultiply(WHITE, alpha),
      );
      const rect = family?.rect;
      if (family && rect) {
        this.rect(base, rect[0], rect[1], rect[2], rect[3]);
        this.f32[base + W_UV] = family.id;
        this.bound(off, index, rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]);
      } else {
        this.rect(base, 0, 0, w, h);
        this.bound(off, index, 0, 0, w, h);
      }
      return;
    }

    const ellipse = node.type === "ellipse" ? FLAG_ELLIPSE : 0;
    const r = this.radiiScratch;
    const radius = node.cornerRadius ?? 0;
    const maxRadius = Math.min(w, h) / 2;
    if (typeof radius === "number") r.fill(Math.min(Math.max(radius, 0), maxRadius));
    else for (let k = 0; k < 4; k++) r[k] = Math.min(Math.max(radius[k]!, 0), maxRadius);

    const shadows = node.shadows;
    if (shadows) {
      for (const shadow of shadows) {
        if (shadow.inset === true) continue;
        const sigma = Math.max(0, shadow.blur) / 2;
        const spread = shadow.spread;
        const base = this.header(
          off,
          index,
          KIND_SHADOW,
          ellipse,
          premultiply(parseColor(shadow.color), alpha),
        );
        const sx = shadow.x - spread;
        const sy = shadow.y - spread;
        const sw = Math.max(0, w + spread * 2);
        const sh = Math.max(0, h + spread * 2);
        this.rect(base, sx, sy, sw, sh);
        this.radii(base, r, spread);
        this.params(base, sigma, shadow.x, shadow.y, spread);
        const e = sigma * 3;
        this.bound(off, index, sx - e, sy - e, sx + sw + e, sy + sh + e);
        off++;
      }
    }
    const fills = node.fills;
    if (fills) {
      let imageSlot = 0;
      for (let k = 0; k < fills.length; k++) {
        const fill = fills[k]!;
        let base: number;
        if (fill.type === "solid") {
          const animated = k === 0 ? this.animFill[index]! : Number.NaN;
          const color = Number.isNaN(animated) ? parseColor(fill.color) : animated;
          base = this.header(off, index, KIND_FILL, ellipse, premultiply(color, alpha));
        } else if (fill.type === "image" || fill.type === "shader") {
          const family = this.slots[index]?.[imageSlot++]?.family ?? null;
          const rect = family?.rect;
          if (family && rect) {
            base = this.header(
              off,
              index,
              KIND_FILL,
              ellipse |
                (PAINT_IMAGE << PAINT_SHIFT) |
                FLAG_TABLE |
                (fill.type === "image" && fill.fit === "tile" ? FLAG_TILE : 0),
              premultiply(WHITE, alpha * (fill.type === "shader" ? (fill.opacity ?? 1) : 1)),
            );
            this.params(base, rect[0], rect[1], rect[2], rect[3]);
            this.f32[base + W_UV] = family.id;
          } else {
            base = this.header(
              off,
              index,
              KIND_FILL,
              ellipse,
              premultiply(IMAGE_PLACEHOLDER, alpha),
            );
          }
        } else {
          const ramp: Ramp | null = this.textures.ramp(fill.stops, index);
          if (!ramp) {
            const first = fill.stops[0];
            base = this.header(
              off,
              index,
              KIND_FILL,
              ellipse,
              premultiply(first ? parseColor(first.color) : 0, alpha),
            );
          } else {
            const linear = fill.type === "linear-gradient";
            base = this.header(
              off,
              index,
              KIND_FILL,
              ellipse |
                ((linear ? PAINT_LINEAR : PAINT_RADIAL) << PAINT_SHIFT) |
                (ramp.region.layer << LAYER_SHIFT),
              premultiply(WHITE, alpha),
            );
            if (linear) {
              const line = linearGradientLine(fill.angle, w, h);
              this.params(base, line[0], line[1], line[2], line[3]);
            } else {
              this.params(
                base,
                w * (fill.center?.x ?? 0.5),
                h * (fill.center?.y ?? 0.5),
                (w / 2) * (fill.size?.width ?? SQRT2),
                (h / 2) * (fill.size?.height ?? SQRT2),
              );
            }
            this.uv(base, ramp.u0, ramp.v, ramp.u1, ramp.v);
          }
        }
        this.rect(base, 0, 0, w, h);
        this.radii(base, r, 0);
        this.bound(off, index, 0, 0, w, h);
        off++;
      }
    }
    if (shadows) {
      for (const shadow of shadows) {
        if (shadow.inset !== true) continue;
        const base = this.header(
          off,
          index,
          KIND_INSET,
          ellipse,
          premultiply(parseColor(shadow.color), alpha),
        );
        this.rect(base, 0, 0, w, h);
        this.radii(base, r, 0);
        this.params(base, Math.max(0, shadow.blur) / 2, shadow.x, shadow.y, shadow.spread);
        this.bound(off, index, 0, 0, w, h);
        off++;
      }
    }
    const strokes = node.strokes;
    if (strokes) {
      for (const stroke of strokes) {
        const width = Math.max(0, stroke.width);
        const align = stroke.align ?? "inside";
        const inner = align === "inside" ? width : align === "center" ? width / 2 : 0;
        const outer = width - inner;
        const base = this.header(
          off,
          index,
          KIND_STROKE,
          ellipse,
          width > 0 ? premultiply(parseColor(stroke.color), alpha) : 0,
        );
        this.rect(base, 0, 0, w, h);
        this.radii(base, r, 0);
        // Dashes use the first on/off pair; one value means equal gaps.
        const dash = stroke.dash;
        const dashOn = dash && dash.length > 0 ? Math.max(0, dash[0]!) : 0;
        const dashOff = dash && dash.length > 0 ? Math.max(0, dash[1] ?? dash[0]!) : 0;
        const dashed = dashOn > 0 && dashOff > 0;
        this.params(base, inner, outer, dashed ? dashOn : 0, dashed ? dashOff : 0);
        this.bound(off, index, -outer, -outer, w + outer, h + outer);
        off++;
      }
    }
  }

  private encodeText(
    off: number,
    index: number,
    node: CanvasNode,
    w: number,
    h: number,
    alpha: number,
  ) {
    const text = node.text!;
    const family = this.slots[index]?.[0]?.family ?? null;
    const layout = family?.layout ?? null;
    const rect = family?.rect ?? null;
    const lineHeight = layout?.lineHeight ?? lineHeightPx(text, text.fontSize * 1.2);
    const lines = layout?.lines.length ?? Math.max(1, Math.round(h / Math.max(lineHeight, 1)));
    const top = layout?.top ?? 0;
    const base = this.header(
      off,
      index,
      KIND_TEXT,
      family && rect ? FLAG_TABLE : 0,
      premultiply(parseColor(text.color), alpha),
    );
    if (family && rect) {
      this.rect(base, rect[0], rect[1], rect[2], rect[3]);
      this.f32[base + W_UV] = family.id;
      this.params(base, lineHeight, text.fontSize, lines, top - rect[1]);
      this.bound(off, index, rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]);
    } else {
      const height = Math.max(h, lines * lineHeight);
      this.rect(base, 0, 0, w, height);
      this.params(base, lineHeight, text.fontSize, lines, top);
      this.bound(off, index, 0, 0, w, height);
    }
  }

  private markReencode(index: number) {
    if (this.reencodeFlag[index] === 1) return;
    this.reencodeFlag[index] = 1;
    this.reencodeIncoming.push(index);
  }

  get reencodePending() {
    return (
      this.reencodeIncoming.length > 0 ||
      this.reencodeFront.length > this.frontHead ||
      this.reencodeList.length > this.reencodeHead
    );
  }

  /**
   * Sorts new re-encodes into the work queues: those in view go to the front
   * queue, the rest behind the remaining work, each run in buffer order so a
   * slice dirties few upload chunks.
   */
  private mergeReencodes() {
    const primStart = this.primStart;
    const aabb = this.aabb;
    const view = this.passView;
    const incoming = this.reencodeIncoming;
    const byStart = (a: number, b: number) => primStart[a]! - primStart[b]!;
    incoming.sort(byStart);
    for (const index of incoming) {
      const ab = index * 4;
      const inView =
        aabb[ab]! <= view[2]! &&
        aabb[ab + 2]! >= view[0]! &&
        aabb[ab + 1]! <= view[3]! &&
        aabb[ab + 3]! >= view[1]!;
      (inView ? this.reencodeFront : this.reencodeList).push(index);
    }
    incoming.length = 0;
  }

  /**
   * Re-encodes nodes whose texture source changed, stopping after `budgetMs`
   * or once `maxChunks` upload chunks are dirty so one slice never uploads
   * much. Returns true when anything changed.
   */
  flushReencode(budgetMs = Infinity, maxChunks = Infinity): boolean {
    if (!this.reencodePending) return false;
    const start = performance.now();
    if (this.reencodeIncoming.length > 0) this.mergeReencodes();
    let chunks = 0;
    let lastChunk = -1;
    for (let pass = 0; pass < 2; pass++) {
      const list = pass === 0 ? this.reencodeFront : this.reencodeList;
      let head = pass === 0 ? this.frontHead : this.reencodeHead;
      while (head < list.length) {
        const index = list[head]!;
        const chunk = (this.primStart[index]! / CHUNK) | 0;
        if (chunk !== lastChunk) {
          if (++chunks > maxChunks) break;
          lastChunk = chunk;
        }
        head++;
        this.reencodeFlag[index] = 0;
        if (this.nodes[index] !== undefined && this.orderPos[index]! >= 0) {
          this.encodeNode(index, this.effective(index));
        }
        if (performance.now() - start > budgetMs) {
          chunks = maxChunks + 1;
          break;
        }
      }
      if (head >= list.length) {
        list.length = 0;
        head = 0;
      }
      if (pass === 0) this.frontHead = head;
      else this.reencodeHead = head;
      if (chunks > maxChunks) break;
    }
    return true;
  }

  /** Re-encodes every drawn node (after a context restore). */
  reencodeAll() {
    for (let index = 0; index < this.ids.length; index++) {
      if (this.nodes[index] !== undefined && this.orderPos[index]! >= 0) {
        this.encodeNode(index, this.effective(index));
      }
    }
    this.fullUpload = true;
  }

  /** Forces the next texture pass to scan the whole view. */
  invalidateTexturePass() {
    this.lastPass[4] = 0;
  }

  private enqueueTex(index: number) {
    if (this.texQueued[index] === 1) return;
    this.texQueued[index] = 1;
    this.texQueue.push(index);
  }

  private pinTextures(index: number) {
    if (this.orderPos[index]! < 0 || this.alpha[index]! <= 0) return;
    for (const slot of this.slots[index] ?? []) {
      if (slot.family) this.textures.pin(slot.family);
    }
  }

  /**
   * Queues textured nodes inside the world rect for a raster check at
   * `pxPerWorld`. At an unchanged scale only newly exposed strips are scanned,
   * with periodic full passes to keep visible atlas pages resident. A scale
   * change re-queues the view, `inner` (the visible part of the rect) first.
   */
  texturePass(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pxPerWorld: number,
    frame: number,
    inner?: readonly [number, number, number, number],
  ) {
    const last = this.lastPass;
    // Distant pans must release the old view's pages immediately. Incremental
    // passes otherwise keep them pinned until the next periodic full pass.
    const sameScale =
      ++this.incrementalPasses < 16 &&
      last[4]! > 0 &&
      x0 < last[2]! &&
      x1 > last[0]! &&
      y0 < last[3]! &&
      y1 > last[1]! &&
      bucketFor(pxPerWorld) === bucketFor(last[4]!) &&
      Math.abs(Math.log2(pxPerWorld / last[4]!)) < 0.25;
    if (!sameScale) {
      this.incrementalPasses = 0;
      this.textures.passFrame = frame;
      this.textures.touchRamps();
      // Everything queued is re-found below if still in view.
      const queue = this.texQueue;
      for (let k = this.texHead; k < queue.length; k++) this.texQueued[queue[k]!] = 0;
      queue.length = 0;
      this.texHead = 0;
      if (inner && (inner[0] < x0 || inner[1] < y0 || inner[2] > x1 || inner[3] > y1)) {
        this.passRect(inner[0], inner[1], inner[2], inner[3]);
        this.passRect(x0, y0, x1, y1);
      } else {
        this.passRect(x0, y0, x1, y1, inner);
      }
      last[4] = pxPerWorld;
    } else {
      const lx0 = last[0]!;
      const ly0 = last[1]!;
      const lx1 = last[2]!;
      const ly1 = last[3]!;
      if (y0 < ly0) this.passRect(x0, y0, x1, Math.min(y1, ly0));
      if (y1 > ly1) this.passRect(x0, Math.max(y0, ly1), x1, y1);
      const my0 = Math.max(y0, ly0);
      const my1 = Math.min(y1, ly1);
      if (my0 < my1) {
        if (x0 < lx0) this.passRect(x0, my0, Math.min(x1, lx0), my1);
        if (x1 > lx1) this.passRect(Math.max(x0, lx1), my0, x1, my1);
      }
    }
    last[0] = x0;
    last[1] = y0;
    last[2] = x1;
    last[3] = y1;
    const view = this.passView;
    view[0] = x0;
    view[1] = y0;
    view[2] = x1;
    view[3] = y1;
    view[4] = pxPerWorld;
  }

  /** True while queued nodes still need a raster check. */
  get texturesQueued() {
    return this.texQueue.length > this.texHead && this.passView[4]! > 0;
  }

  /**
   * Checks queued nodes against the latest pass until `budgetMs` elapses,
   * requesting rasters (and creating text layouts) as needed.
   */
  drainTextures(budgetMs = Infinity) {
    const view = this.passView;
    const pxPerWorld = view[4]!;
    if (pxPerWorld <= 0) return;
    const queue = this.texQueue;
    let head = this.texHead;
    const start = performance.now();
    while (head < queue.length) {
      const index = queue[head++]!;
      this.texQueued[index] = 0;
      this.wantNode(index, view[0]!, view[1]!, view[2]!, view[3]!, pxPerWorld);
      if (performance.now() - start > budgetMs) break;
    }
    if (head >= queue.length) {
      queue.length = 0;
      head = 0;
    }
    this.texHead = head;
  }

  private passRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    inner?: readonly [number, number, number, number],
  ) {
    const count = this.textureGrid.queryRect(x0, y0, x1, y1);
    const results = this.textureGrid.results;
    const aabb = this.aabb;
    if (inner) {
      for (let k = 0; k < count; k++) {
        const index = results[k]!;
        const ab = index * 4;
        if (
          aabb[ab]! <= inner[2] &&
          aabb[ab + 2]! >= inner[0] &&
          aabb[ab + 1]! <= inner[3] &&
          aabb[ab + 3]! >= inner[1]
        ) {
          this.pinTextures(index);
          this.enqueueTex(index);
        }
      }
    }
    for (let k = 0; k < count; k++) {
      const index = results[k]!;
      const ab = index * 4;
      if (
        !inner &&
        aabb[ab]! <= x1 &&
        aabb[ab + 2]! >= x0 &&
        aabb[ab + 1]! <= y1 &&
        aabb[ab + 3]! >= y0
      )
        this.pinTextures(index);
      this.enqueueTex(index);
    }
  }

  private wantNode(
    index: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pxPerWorld: number,
  ) {
    if (this.orderPos[index]! < 0) return;
    const ab = index * 4;
    if (
      this.aabb[ab]! > x1 ||
      this.aabb[ab + 2]! < x0 ||
      this.aabb[ab + 1]! > y1 ||
      this.aabb[ab + 3]! < y0
    ) {
      return;
    }
    const node = this.effective(index);
    const wo = index * 6;
    const scale = Math.sqrt(
      Math.abs(this.world[wo]! * this.world[wo + 3]! - this.world[wo + 1]! * this.world[wo + 2]!),
    );
    const ppu = pxPerWorld * scale;
    const g = index * 4;
    const w = this.geom[g + 2]!;
    const h = this.geom[g + 3]!;
    if (!textured(node) || (node.type === "text" && !node.text)) return;
    const bucket = bucketFor(ppu);
    if (node.type === "text" || node.type === "path" || node.type === "line") {
      this.wantSlot(index, 0, node, w, h, bucket, -1);
    } else if (node.fills) {
      let imageSlot = 0;
      for (let f = 0; f < node.fills.length; f++) {
        if (node.fills[f]!.type === "image" || node.fills[f]!.type === "shader") {
          this.wantSlot(index, imageSlot++, node, w, h, bucket, f);
        }
      }
    }
  }

  private wantSlot(
    index: number,
    k: number,
    node: CanvasNode,
    w: number,
    h: number,
    bucket: number,
    fillIndex: number,
  ) {
    let slots = this.slots[index];
    if (!slots) {
      slots = [];
      this.slots[index] = slots;
    }
    let slot = slots[k];
    if (!slot) {
      slot = { node: null, w: 0, h: 0, family: null };
      slots[k] = slot;
    }
    if (slot.node !== node || slot.w !== w || slot.h !== h || !slot.family) {
      let family: TexFamily;
      if (node.type === "text") family = this.textures.textFamily(node.text!, w, h);
      else if (fillIndex < 0) family = this.textures.pathFamily(node, w, h);
      else {
        const fill = node.fills![fillIndex]!;
        if (fill.type === "shader") family = this.textures.shaderFamily(fill, w, h);
        else if (fill.type === "image")
          family = this.textures.imageFamily(fill.assetId, fill.fit, w, h);
        else return;
      }
      if (slot.family !== family) {
        slot.family?.users.delete(index);
        family.users.add(index);
        slot.family = family;
        this.markReencode(index);
      }
      slot.node = node;
      slot.w = w;
      slot.h = h;
    }
    this.textures.want(slot.family, bucket);
  }

  onFamilyChanged(family: TexFamily) {
    for (const user of family.users) this.markReencode(user);
  }

  /** Only shader fills intersecting the actual viewport advance their clock. */
  shaderFrame(
    timeSeconds: number,
    playing: boolean,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    const visible = this.visibleShaders;
    visible.clear();
    for (const index of this.shaderNodes) {
      if (this.orderPos[index]! < 0 || this.alpha[index]! <= 0) continue;
      const ab = index * 4;
      if (
        this.aabb[ab]! > x1 ||
        this.aabb[ab + 2]! < x0 ||
        this.aabb[ab + 1]! > y1 ||
        this.aabb[ab + 3]! < y0
      )
        continue;
      let slot = 0;
      for (const fill of this.effective(index).fills ?? []) {
        if (fill.type !== "image" && fill.type !== "shader") continue;
        const family = this.slots[index]?.[slot++]?.family;
        if (family && fill.type === "shader" && (fill.opacity ?? 1) > 0) visible.add(family);
      }
    }
    return this.textures.shaderFrame(visible, timeSeconds, playing);
  }

  onRampEvicted(ramp: Ramp) {
    for (const user of ramp.users) this.markReencode(user);
    ramp.users.clear();
  }

  /** Hover and selection outlines: `widthPx` device px just outside the node box, at any zoom. */
  setOverlay(
    hover: string | null,
    selection: ReadonlyArray<string>,
    color: number,
    widthPx: number,
  ) {
    this.overlayCount = 0;
    const add = (id: string) => {
      const index = this.idToIndex.get(id);
      if (index === undefined || this.orderPos[index]! < 0) return;
      const need = (this.overlayCount + 1) * STRIDE;
      if (need > this.overlayF32.length) {
        const next = new Float32Array(this.overlayF32.length * 2);
        next.set(this.overlayF32);
        this.overlayF32 = next;
        this.overlayU32 = new Uint32Array(next.buffer);
      }
      const f = this.overlayF32;
      const base = this.overlayCount * STRIDE;
      const wo = index * 6;
      for (let k = 0; k < 6; k++) f[base + k] = this.world[wo + k]!;
      f[base + 6] = 0;
      f[base + 7] = 0;
      f[base + 8] = this.geom[index * 4 + 2]!;
      f[base + 9] = this.geom[index * 4 + 3]!;
      for (let k = 10; k < 14; k++) f[base + k] = 0;
      f[base + W_CLIP] = 0;
      f[base + W_CLIP + 1] = 0;
      f[base + W_CLIP + 2] = NO_CLIP;
      f[base + W_CLIP + 3] = NO_CLIP;
      f[base + W_CLIP + 4] = 1;
      f[base + W_CLIP + 5] = 0;
      f[base + W_CLIP + 6] = 0;
      f[base + W_PARAMS] = 0;
      f[base + W_PARAMS + 1] = widthPx;
      f[base + W_PARAMS + 2] = 0;
      f[base + W_PARAMS + 3] = 0;
      this.overlayU32[base + W_COLOR] = premultiply(color, 1);
      this.overlayU32[base + W_FLAGS] = KIND_STROKE | FLAG_SCREEN;
      f[base + W_EFFECT_ALPHA] = 1;
      this.overlayCount++;
    };
    for (const id of selection) add(id);
    if (hover !== null && !selection.includes(hover)) add(hover);
  }

  private syncAnimation(index: number, node: CanvasNode) {
    const animations = node.animations;
    if (!animations || animations.length === 0) {
      this.anim[index] = undefined;
      this.animated.delete(index);
      this.animFill[index] = Number.NaN;
      this.animScale[index] = 1;
      return;
    }
    const previous = this.anim[index];
    if (previous && previous.node === node) return;
    const same = previous?.node.animations === animations;
    const starts = same ? previous!.starts : new Float64Array(animations.length).fill(Number.NaN);
    if ((this.playing || this.pausedAt !== null) && !same) {
      for (let k = 0; k < animations.length; k++) {
        if ((animations[k]!.trigger ?? "load") === "load")
          starts[k] = this.pausedAt ?? this.playStart;
      }
    }
    const override: Record<string, unknown> = { ...node };
    if (same) {
      for (const animation of animations) {
        const property = animation.property;
        if (
          property !== "fill" &&
          property !== "scale" &&
          node[property] === previous!.node[property]
        ) {
          override[property] = previous!.override[property];
        }
      }
      if (node.fills !== previous!.node.fills) this.animFill[index] = Number.NaN;
    } else {
      this.animFill[index] = Number.NaN;
      this.animScale[index] = 1;
    }
    this.anim[index] = {
      node,
      starts,
      override,
      settled: false,
      motionBounds: this.animationBounds(node),
    };
    this.animated.add(index);
  }

  setPlaying(playing: boolean, now: number) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) {
      this.pausedAt = now;
      return;
    }
    const pausedFor = this.pausedAt === null ? 0 : now - this.pausedAt;
    this.playStart = this.pausedAt === null ? now : this.playStart + pausedFor;
    this.pausedAt = null;
    for (const index of this.animated) {
      const state = this.anim[index]!;
      const animations = state.node.animations ?? [];
      for (let k = 0; k < animations.length; k++) {
        if (!Number.isNaN(state.starts[k]!)) state.starts[k]! += pausedFor;
        else if ((animations[k]!.trigger ?? "load") === "load") state.starts[k] = now;
      }
      state.settled = false;
    }
  }

  /** Covers numeric keyframes and spring overshoot so moving layers can return from offscreen. */
  private animationBounds(node: CanvasNode): AnimState["motionBounds"] {
    const ranges = {
      x: [node.x, node.x],
      y: [node.y, node.y],
      width: [node.width, node.width],
      height: [node.height, node.height],
      scale: [1, 1],
    };
    let motion = false;
    for (const animation of node.animations ?? []) {
      const property = animation.property;
      if (property === "rotation") {
        motion = true;
        continue;
      }
      if (!(property in ranges)) continue;
      motion = true;
      const range = ranges[property as keyof typeof ranges];
      let lo = range[0]!;
      let hi = range[1]!;
      for (const keyframe of animation.keyframes) {
        const value =
          typeof keyframe.value === "number" ? keyframe.value : Number.parseFloat(keyframe.value);
        if (!Number.isFinite(value)) continue;
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      const pad = animation.keyframes.some((keyframe) => keyframe.easing === "spring")
        ? hi - lo
        : 0;
      range[0] = lo - pad;
      range[1] = hi + pad;
    }
    if (!motion) return null;
    const width = Math.max(Math.abs(ranges.width[0]!), Math.abs(ranges.width[1]!));
    const height = Math.max(Math.abs(ranges.height[0]!), Math.abs(ranges.height[1]!));
    const scale = Math.max(Math.abs(ranges.scale[0]!), Math.abs(ranges.scale[1]!));
    let radius = (Math.hypot(width, height) * scale) / 2;
    for (const shadow of node.shadows ?? []) {
      radius += Math.abs(shadow.x) + Math.abs(shadow.y) + shadow.blur * 3 + Math.abs(shadow.spread);
    }
    return [
      ranges.x[0]! + ranges.width[0]! / 2 - radius,
      ranges.y[0]! + ranges.height[0]! / 2 - radius,
      ranges.x[1]! + ranges.width[1]! / 2 + radius,
      ranges.y[1]! + ranges.height[1]! / 2 + radius,
    ];
  }

  private animationCanEnter(
    index: number,
    state: AnimState,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): boolean {
    const bounds = state.motionBounds;
    if (!bounds) return false;
    // Descendants can overflow a group's own box; do not cull their parent's motion by that box.
    if (state.node.childIds?.length) return true;
    const parent = this.parent[index]!;
    if (parent < 0) return bounds[0] <= x1 && bounds[2] >= x0 && bounds[1] <= y1 && bounds[3] >= y0;
    const o = parent * 6;
    const a = this.world[o]!;
    const b = this.world[o + 1]!;
    const c = this.world[o + 2]!;
    const d = this.world[o + 3]!;
    const cx = (bounds[0] + bounds[2]) / 2;
    const cy = (bounds[1] + bounds[3]) / 2;
    const hx = (bounds[2] - bounds[0]) / 2;
    const hy = (bounds[3] - bounds[1]) / 2;
    const wx = a * cx + c * cy + this.world[o + 4]!;
    const wy = b * cx + d * cy + this.world[o + 5]!;
    const rx = Math.abs(a) * hx + Math.abs(c) * hy;
    const ry = Math.abs(b) * hx + Math.abs(d) * hy;
    return wx - rx <= x1 && wx + rx >= x0 && wy - ry <= y1 && wy + ry >= y0;
  }

  trigger(id: string, trigger: "load" | "hover" | "press", now: number): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;
    const state = this.anim[index];
    if (!state) return false;
    let started = false;
    const animations = state.node.animations ?? [];
    for (let k = 0; k < animations.length; k++) {
      if ((animations[k]!.trigger ?? "load") === trigger) {
        state.starts[k] = now;
        started = true;
      }
    }
    if (started) state.settled = false;
    return started;
  }

  get isPlaying() {
    return this.playing;
  }

  /**
   * Applies animation values for `now`. Returns true while any animation on a
   * visible node, or one whose motion can enter the view, is running.
   */
  tickAnimations(now: number, x0: number, y0: number, x1: number, y1: number): boolean {
    if (!this.playing) return false;
    let running = false;
    let changed = false;
    for (const index of this.animated) {
      if (this.orderPos[index]! < 0) continue;
      const state = this.anim[index]!;
      const animations = state.node.animations ?? [];
      let active = false;
      let activeMotion = false;
      for (let k = 0; k < animations.length; k++) {
        const start = state.starts[k]!;
        const animation = animations[k]!;
        if (!Number.isNaN(start) && now - start < animationEndMs(animation)) {
          active = true;
          if (
            animation.property !== "fill" &&
            animation.property !== "opacity" &&
            animation.property !== "cornerRadius"
          )
            activeMotion = true;
        }
      }
      if (!active) {
        // One last pass so finished animations rest on their final value.
        if (state.settled) continue;
        state.settled = true;
      } else {
        const ab = index * 4;
        let visible =
          this.aabb[ab]! <= x1 &&
          this.aabb[ab + 2]! >= x0 &&
          this.aabb[ab + 1]! <= y1 &&
          this.aabb[ab + 3]! >= y0;
        if (!visible && state.node.childIds?.length) {
          const start = this.primStart[index]!;
          const end = this.subtreeEnd[index]!;
          const bounds = this.animationViewBounds;
          this.spanBounds(start, end, bounds);
          visible = bounds[0]! <= x1 && bounds[2]! >= x0 && bounds[1]! <= y1 && bounds[3]! >= y0;
          // Newly encoded chunks have not reached the upload/bounds pass yet.
          if (!visible) {
            for (let chunk = Math.floor(start / CHUNK); chunk < Math.ceil(end / CHUNK); chunk++) {
              if (this.chunkDirty[chunk] === 1) {
                visible = true;
                break;
              }
            }
          }
        }
        if (!visible && (!activeMotion || !this.animationCanEnter(index, state, x0, y0, x1, y1)))
          continue;
        running = true;
      }
      const override = state.override as MutableNode & Record<string, unknown>;
      let dirty = false;
      for (let k = 0; k < animations.length; k++) {
        const start = state.starts[k]!;
        if (Number.isNaN(start)) continue;
        const animation = animations[k]!;
        const value = sampleAnimation(animation, now - start);
        if (Number.isNaN(value)) continue;
        switch (animation.property) {
          case "fill":
            if (this.animFill[index] !== value) dirty = true;
            this.animFill[index] = value;
            break;
          case "scale":
            if (this.animScale[index] !== Math.fround(value)) dirty = true;
            this.animScale[index] = Math.fround(value);
            break;
          default:
            if (override[animation.property] !== value) dirty = true;
            override[animation.property] = value;
        }
      }
      if (dirty) {
        this.updateSubtree(index);
        changed = true;
      }
    }
    return running || changed;
  }

  /**
   * Writes drawn effect roots as `[start, end, index]` instance spans sorted
   * by start into `out` and returns the count. Spans never overlap.
   */
  collectEffects(out: { spans: Int32Array }): number {
    if (this.effectsDirty) {
      const ordered = [...this.effects].filter(
        (index) => this.orderPos[index]! >= 0 && this.subtreeEnd[index]! > this.primStart[index]!,
      );
      ordered.sort((a, b) => this.primStart[a]! - this.primStart[b]!);
      if (this.effectSpans.length < ordered.length * 3) {
        this.effectSpans = new Int32Array(ordered.length * 6);
      }
      for (let k = 0; k < ordered.length; k++) {
        const index = ordered[k]!;
        this.effectSpans[k * 3] = this.primStart[index]!;
        this.effectSpans[k * 3 + 1] = this.subtreeEnd[index]!;
        this.effectSpans[k * 3 + 2] = index;
      }
      this.effectCount = ordered.length;
      this.effectsDirty = false;
    }
    out.spans = this.effectSpans;
    return this.effectCount;
  }

  /** Composite opacity of an effect root. */
  effectOpacity(index: number): number {
    const parent = this.parent[index]!;
    return (parent >= 0 ? this.alpha[parent]! : 1) * (this.effective(index).opacity ?? 1);
  }

  /** Layer blur of an effect root as a gaussian sigma in world units. */
  effectBlur(index: number): number {
    const blur = this.effective(index).layerBlur ?? 0;
    if (blur <= 0) return 0;
    const wo = index * 6;
    const scale = Math.sqrt(
      Math.abs(this.world[wo]! * this.world[wo + 3]! - this.world[wo + 1]! * this.world[wo + 2]!),
    );
    return blur * scale;
  }

  /** World bounds of instances [start, end), from upload chunk bounds (conservative). */
  spanBounds(start: number, end: number, out: Float64Array) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const aabb = this.chunkAabb;
    const last = ((end - 1) / CHUNK) | 0;
    for (let chunk = (start / CHUNK) | 0; chunk <= last; chunk++) {
      const o = chunk * 4;
      if (aabb[o]! < x0) x0 = aabb[o]!;
      if (aabb[o + 1]! < y0) y0 = aabb[o + 1]!;
      if (aabb[o + 2]! > x1) x1 = aabb[o + 2]!;
      if (aabb[o + 3]! > y1) y1 = aabb[o + 3]!;
    }
    out[0] = x0;
    out[1] = y0;
    out[2] = x1;
    out[3] = y1;
  }

  private paintKey(index: number) {
    return this.rootRank[this.rootOf[index]!]! * ORDER_SPAN + this.orderPos[index]!;
  }

  /** Topmost node under a world point. */
  hitTest(wx: number, wy: number, deep: boolean): string | null {
    const count = this.grid.queryPoint(wx, wy);
    const results = this.grid.results;
    let best = -1;
    let bestKey = -1;
    for (let k = 0; k < count; k++) {
      const index = results[k]!;
      if (this.orderPos[index]! < 0) continue;
      const key = this.paintKey(index);
      if (key <= bestKey) continue;
      const node = this.nodes[index];
      if (!node || node.type === "group" || this.locked[index] === 1) continue;
      if (!this.containsPoint(index, node, wx, wy)) continue;
      best = index;
      bestKey = key;
    }
    if (best < 0) return null;
    return this.ids[deep ? best : this.selectionTarget(best)]!;
  }

  /** Maps a deep hit to the node a plain click selects. */
  private selectionTarget(index: number): number {
    let child = index;
    let current = index;
    while (this.parent[current]! >= 0) {
      child = current;
      current = this.parent[current]!;
    }
    if (current === index) return index;
    return this.nodes[current]!.type === "frame" ? child : current;
  }

  private containsPoint(index: number, node: CanvasNode, wx: number, wy: number) {
    const c = index * CLIP_SIZE;
    const clip = this.clip;
    if (clip[c + 2]! < NO_CLIP) {
      const dx = wx - clip[c]!;
      const dy = wy - clip[c + 1]!;
      const px = clip[c + 4]! * dx + clip[c + 5]! * dy;
      const py = clip[c + 4]! * dy - clip[c + 5]! * dx;
      if (Math.abs(px) > clip[c + 2]! || Math.abs(py) > clip[c + 3]!) return false;
    }
    const wo = index * 6;
    const a = this.world[wo]!;
    const b = this.world[wo + 1]!;
    const cc = this.world[wo + 2]!;
    const d = this.world[wo + 3]!;
    const det = a * d - b * cc;
    if (Math.abs(det) < 1e-12) return false;
    const dx = wx - this.world[wo + 4]!;
    const dy = wy - this.world[wo + 5]!;
    const lx = (d * dx - cc * dy) / det;
    const ly = (-b * dx + a * dy) / det;
    const w = this.geom[index * 4 + 2]!;
    const h = this.geom[index * 4 + 3]!;
    if (node.type === "ellipse") {
      const nx = (lx - w / 2) / (w / 2);
      const ny = (ly - h / 2) / (h / 2);
      return nx * nx + ny * ny <= 1;
    }
    const slack = node.type === "line" ? 4 / Math.sqrt(Math.abs(det)) : 0;
    return lx >= -slack && ly >= -slack && lx <= w + slack && ly <= h + slack;
  }

  hitTestRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const count = this.grid.queryRect(x0, y0, x1, y1);
    const results = this.grid.results;
    const picked = new Set<number>();
    for (let k = 0; k < count; k++) {
      const index = results[k]!;
      if (this.orderPos[index]! < 0 || this.locked[index] === 1) continue;
      const node = this.nodes[index];
      if (!node || node.type === "group") continue;
      const ab = index * 4;
      if (
        this.aabb[ab]! > x1 ||
        this.aabb[ab + 2]! < x0 ||
        this.aabb[ab + 1]! > y1 ||
        this.aabb[ab + 3]! < y0
      ) {
        continue;
      }
      const target = this.selectionTarget(index);
      if (picked.has(target)) continue;
      const tb = target * 4;
      // Top-level frames need to be fully enclosed, so a marquee inside one picks its children.
      const enclosed =
        this.aabb[tb]! >= x0 &&
        this.aabb[tb + 1]! >= y0 &&
        this.aabb[tb + 2]! <= x1 &&
        this.aabb[tb + 3]! <= y1;
      if (
        this.parent[target]! < 0 &&
        this.nodes[target]!.type === "frame" &&
        (this.nodes[target]!.childIds?.length ?? 0) > 0 &&
        !enclosed
      ) {
        continue;
      }
      picked.add(target);
    }
    return [...picked]
      .sort((a, b) => this.paintKey(a) - this.paintKey(b))
      .map((index) => this.ids[index]!);
  }

  /** Converts a world-space drag delta to coordinates inside the node. */
  worldDeltaToLocal(id: string | null, dx: number, dy: number) {
    if (id === null) return { x: dx, y: dy };
    const index = this.idToIndex.get(id);
    if (index === undefined || this.orderPos[index]! < 0) return null;
    const wo = index * 6;
    const a = this.world[wo]!;
    const b = this.world[wo + 1]!;
    const c = this.world[wo + 2]!;
    const d = this.world[wo + 3]!;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    return { x: (d * dx - c * dy) / det, y: (-b * dx + a * dy) / det };
  }

  worldBounds(id: string) {
    const index = this.idToIndex.get(id);
    if (index === undefined || this.orderPos[index]! < 0) return null;
    const wo = index * 6;
    const a = this.world[wo]!;
    const b = this.world[wo + 1]!;
    const scale = Math.hypot(a, b);
    const w = this.geom[index * 4 + 2]!;
    const h = this.geom[index * 4 + 3]!;
    const cx = a * (w / 2) + this.world[wo + 2]! * (h / 2) + this.world[wo + 4]!;
    const cy = b * (w / 2) + this.world[wo + 3]! * (h / 2) + this.world[wo + 5]!;
    return {
      x: cx - (w * scale) / 2,
      y: cy - (h * scale) / 2,
      width: w * scale,
      height: h * scale,
      rotation: (Math.atan2(b, a) * 180) / Math.PI,
    };
  }

  /** World AABB covering a node's subtree including shadows and blur, or the whole scene. */
  paintBounds(id?: string): [number, number, number, number] | null {
    let from = 0;
    let to = this.instCount;
    if (id !== undefined) {
      const index = this.idToIndex.get(id);
      if (index === undefined || this.orderPos[index]! < 0) return null;
      from = this.primStart[index]!;
      to = this.subtreeEnd[index]!;
      if (from === to) {
        const ab = index * 4;
        return [this.aabb[ab]!, this.aabb[ab + 1]!, this.aabb[ab + 2]!, this.aabb[ab + 3]!];
      }
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = from; k < to; k++) {
      const o = k * 4;
      x0 = Math.min(x0, this.instAabb[o]!);
      y0 = Math.min(y0, this.instAabb[o + 1]!);
      x1 = Math.max(x1, this.instAabb[o + 2]!);
      y1 = Math.max(y1, this.instAabb[o + 3]!);
    }
    // Keep a conservative halo so screenshots do not crop a layer's blur.
    let halo = 0;
    for (const index of this.effects) {
      if (this.primStart[index]! < to && this.subtreeEnd[index]! > from) {
        halo = Math.max(halo, this.effectBlur(index) * 3);
      }
    }
    return x0 <= x1 ? [x0 - halo, y0 - halo, x1 + halo, y1 + halo] : null;
  }

  /** Instance range [start, end) for a node subtree. */
  instanceRange(id: string): [number, number] | null {
    const index = this.idToIndex.get(id);
    if (index === undefined || this.orderPos[index]! < 0) return null;
    return [this.primStart[index]!, this.subtreeEnd[index]!];
  }

  /** Union of node boxes for `ids`. */
  boxBounds(ids: ReadonlyArray<string>): [number, number, number, number] | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const index = this.idToIndex.get(id);
      if (index === undefined || this.orderPos[index]! < 0) continue;
      const ab = index * 4;
      x0 = Math.min(x0, this.aabb[ab]!);
      y0 = Math.min(y0, this.aabb[ab + 1]!);
      x1 = Math.max(x1, this.aabb[ab + 2]!);
      y1 = Math.max(y1, this.aabb[ab + 3]!);
    }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
  }

  countVisible(x0: number, y0: number, x1: number, y1: number): number {
    const count = this.grid.queryRect(x0, y0, x1, y1);
    const results = this.grid.results;
    let visible = 0;
    for (let k = 0; k < count; k++) {
      const ab = results[k]! * 4;
      if (
        this.aabb[ab]! <= x1 &&
        this.aabb[ab + 2]! >= x0 &&
        this.aabb[ab + 1]! <= y1 &&
        this.aabb[ab + 3]! >= y0
      ) {
        visible++;
      }
    }
    return visible;
  }

  /** Asset ids referenced by image fills inside a subtree (or the whole document). */
  assetIdsIn(id?: string): Set<string> {
    const assets = new Set<string>();
    const doc = this.doc;
    if (!doc) return assets;
    const stack = id !== undefined ? [id] : [...doc.rootIds];
    while (stack.length > 0) {
      const node = doc.nodes[stack.pop()!];
      if (!node || node.visible === false) continue;
      for (const fill of node.fills ?? []) if (fill.type === "image") assets.add(fill.assetId);
      if (node.childIds) stack.push(...node.childIds);
    }
    return assets;
  }
}

function uniformRadius(node: CanvasNode, w: number, h: number) {
  const radius = node.cornerRadius ?? 0;
  const value = typeof radius === "number" ? radius : Math.min(...radius);
  return Math.min(Math.max(0, value), Math.min(w, h) / 2);
}
