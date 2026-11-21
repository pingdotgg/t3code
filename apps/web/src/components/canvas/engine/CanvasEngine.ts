import type { CanvasDocument, CanvasOp } from "@t3tools/contracts";

import { TextureAtlas } from "./atlas";
import { EffectLayers, type LayerBox } from "./effects";
import { parseColor, toPremultipliedFloats } from "./color";
import { Renderer, type ViewUniforms } from "./renderer";
import { CHUNK, Scene } from "./scene";
import { TextureCache } from "./textures";

export interface CanvasViewport {
  /** World x at the screen's left edge. */
  x: number;
  /** World y at the screen's top edge. */
  y: number;
  zoom: number;
}

export interface CanvasEngineOptions {
  background?: string;
  /** Hover and selection outline color. */
  selectionColor?: string;
  onError?: (message: string) => void;
}

export interface CanvasWorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the box center. */
  rotation: number;
}

export interface CanvasEngineStats {
  fps: number;
  /** CPU time of the last rendered frame. */
  lastFrameMs: number;
  visibleNodes: number;
  drawCalls: number;
  /** A newly set document is still encoding; unencoded nodes neither draw nor hit test. */
  loading: boolean;
}

export type CanvasAnimationTrigger = "load" | "hover" | "press";

const MIN_ZOOM = 0.002;
const MAX_ZOOM = 256;
const TEXTURE_PASS_INTERVAL_MS = 50;
/**
 * JS time per frame for background texture work (raster checks, rasters,
 * re-encodes). Each step still makes progress past the budget, so one
 * oversized step can overrun it, never stall.
 */
const FRAME_BUDGET_MS = 5;
/** Share of the frame budget for checking queued nodes (text layout happens here). */
const TEXTURE_CHECK_BUDGET_MS = 1.5;
/** Upload chunks (256 instances, 32 KB each) one frame of texture re-encodes may dirty. */
const REENCODE_MAX_CHUNKS = 16;
/** JS time per frame for encoding a newly loaded document. */
const BUILD_BUDGET_MS = 6;
/** Effect subtrees per frame drawn through a layer; the rest draw with plain opacity. */
const MAX_EFFECT_LAYERS = 16;
/** Agent screenshots: longest side and pixel count caps. */
const EXPORT_MAX_SIDE = 4096;
const EXPORT_MAX_PIXELS = 16e6;
/** Theme-independent backdrop for screenshots (the light canvas color). */
const EXPORT_BACKGROUND = "#f5f5f5";
/** Work per slice while preparing an export, between yields to the event loop. */
const EXPORT_SLICE_MS = 8;
const ATLAS_INITIAL_LAYERS = 2;
const ATLAS_MAX_LAYERS = 8;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Yields to the event loop; unlike setTimeout it is not throttled in hidden tabs. */
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(null);
  });

const profileMode = () => (globalThis as { __T3_CANVAS_PROFILE__?: unknown }).__T3_CANVAS_PROFILE__;

/**
 * WebGL2 design canvas renderer. Pure TS, no React. Renders on demand: every
 * mutation marks the frame dirty and schedules one rAF; nothing runs while
 * idle. Pan and zoom only change uniforms.
 */
export class CanvasEngine {
  private readonly gl: WebGL2RenderingContext;
  private renderer: Renderer;
  private layers: EffectLayers;
  private readonly fx = { spans: new Int32Array(48) };
  private fxDrawn = new Uint8Array(16);
  private readonly fxBounds = new Float64Array(4);
  private readonly fxBox: LayerBox = { x: 0, y: 0, width: 0, height: 0 };
  private exporting = 0;
  private shaderElapsedMs = 0;
  private shaderStartedAt = 0;
  private readonly reportedErrors = new Set<string>();
  private readonly onError: ((message: string) => void) | undefined;
  private readonly atlas: TextureAtlas;
  private readonly textures: TextureCache;
  private readonly scene: Scene;
  private readonly listeners = new Set<(viewport: CanvasViewport) => void>();
  private readonly background = new Float32Array([0.96, 0.96, 0.96, 1]);
  private selectionColor = parseColor("#0d99ff");
  private vx = 0;
  private vy = 0;
  private zoom = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private raf = 0;
  private lost = false;
  private destroyed = false;
  private suspended = false;
  private texPassNeeded = true;
  private lastTexPass = -Infinity;
  private texTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayDirty = true;
  private hover: string | null = null;
  private selection: ReadonlyArray<string> = [];
  private lastFrameMs = 0;
  private readonly frameTimes = new Float64Array(240);
  private frameHead = 0;
  private readonly draw = { ranges: new Int32Array(512) };
  private frame = 0;
  private readonly probe = new Uint8Array(4);
  private readonly view: ViewUniforms = {
    scale: 1,
    tx: 0,
    ty: 0,
    width: 1,
    height: 1,
    x0: 0,
    y0: 0,
    x1: 1,
    y1: 1,
    flipY: 1,
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: CanvasEngineOptions = {},
  ) {
    this.onError = options.onError;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    if (options.background) this.setBackground(options.background);
    if (options.selectionColor) this.selectionColor = parseColor(options.selectionColor);
    this.renderer = new Renderer(gl);
    this.layers = new EffectLayers(gl);
    this.atlas = new TextureAtlas(gl, ATLAS_INITIAL_LAYERS, ATLAS_MAX_LAYERS);
    let scene: Scene | null = null;
    this.textures = new TextureCache(
      gl,
      this.atlas,
      (family) => scene?.onFamilyChanged(family),
      (ramp) => scene?.onRampEvicted(ramp),
      () => {
        scene?.invalidateTexturePass();
        this.texPassNeeded = true;
        this.requestRender();
      },
    );
    scene = new Scene(this.textures);
    this.scene = scene;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /**
   * Diffs by node identity. Pass the op batch that produced `doc` to skip the
   * O(n) scan of `doc.nodes`. A new document encodes over the next frames
   * (`stats().loading`), drawing top-level nodes as they are ready.
   */
  setDocument(doc: CanvasDocument, ops?: ReadonlyArray<CanvasOp>): void {
    if (this.scene.doc === doc) return;
    this.scene.setDocument(doc, ops);
    this.texPassNeeded = true;
    this.overlayDirty = true;
    this.requestRender();
  }

  setBackground(color: string): void {
    toPremultipliedFloats(parseColor(color), this.background);
    this.requestRender();
  }

  setSelectionColor(color: string): void {
    this.selectionColor = parseColor(color);
    this.overlayDirty = true;
    this.requestRender();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = dpr > 0 ? dpr : 1;
    this.overlayDirty = true;
    const width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.viewportChanged();
  }

  getViewport(): CanvasViewport {
    return { x: this.vx, y: this.vy, zoom: this.zoom };
  }

  setViewport(viewport: CanvasViewport): void {
    this.vx = viewport.x;
    this.vy = viewport.y;
    this.zoom = clampZoom(viewport.zoom);
    this.viewportChanged();
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const wx = this.vx + screenX / this.zoom;
    const wy = this.vy + screenY / this.zoom;
    this.zoom = clampZoom(this.zoom * factor);
    this.vx = wx - screenX / this.zoom;
    this.vy = wy - screenY / this.zoom;
    this.viewportChanged();
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.vx -= dxScreen / this.zoom;
    this.vy -= dyScreen / this.zoom;
    this.viewportChanged();
  }

  zoomToFit(nodeIds?: ReadonlyArray<string>, paddingPx = 64): void {
    const scene = this.scene;
    const ids = nodeIds && nodeIds.length > 0 ? nodeIds : null;
    if (ids) scene.continueBuild(Infinity);
    const bounds = ids
      ? scene.boxBounds(ids)
      : scene.building
        ? scene.rootBounds()
        : scene.paintBounds();
    if (!bounds) return;
    const [x0, y0, x1, y1] = bounds;
    const width = Math.max(x1 - x0, 1e-3);
    const height = Math.max(y1 - y0, 1e-3);
    const availW = Math.max(1, this.cssWidth - paddingPx * 2);
    const availH = Math.max(1, this.cssHeight - paddingPx * 2);
    this.zoom = clampZoom(Math.min(availW / width, availH / height));
    this.vx = (x0 + x1) / 2 - this.cssWidth / 2 / this.zoom;
    this.vy = (y0 + y1) / 2 - this.cssHeight / 2 / this.zoom;
    this.viewportChanged();
  }

  onViewportChange(callback: (viewport: CanvasViewport) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    return { x: this.vx + x / this.zoom, y: this.vy + y / this.zoom };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.vx) * this.zoom, y: (y - this.vy) * this.zoom };
  }

  private viewportChanged() {
    this.texPassNeeded = true;
    this.requestRender();
    if (this.listeners.size === 0) return;
    const viewport = this.getViewport();
    for (const listener of this.listeners) listener(viewport);
  }

  /** Absolute unrotated box (top-left before rotation about its center). */
  getWorldBounds(nodeId: string): CanvasWorldBounds | null {
    return this.scene.worldBounds(nodeId);
  }

  /** Converts a world-space drag delta to the selected node's parent coordinates. */
  worldDeltaToLocal(parentId: string | null, dx: number, dy: number) {
    return this.scene.worldDeltaToLocal(parentId, dx, dy);
  }

  /**
   * Topmost node under a screen point. Without `deep` returns what a plain
   * click selects: a top-level frame's direct child, or the top-level node.
   */
  hitTest(screenX: number, screenY: number, options?: { deep?: boolean }): string | null {
    return this.scene.hitTest(
      this.vx + screenX / this.zoom,
      this.vy + screenY / this.zoom,
      options?.deep === true,
    );
  }

  /** Nodes a marquee over `screenRect` selects, back to front. */
  hitTestRect(screenRect: { x: number; y: number; width: number; height: number }): string[] {
    const x0 = Math.min(screenRect.x, screenRect.x + screenRect.width);
    const y0 = Math.min(screenRect.y, screenRect.y + screenRect.height);
    const x1 = Math.max(screenRect.x, screenRect.x + screenRect.width);
    const y1 = Math.max(screenRect.y, screenRect.y + screenRect.height);
    return this.scene.hitTestRect(
      this.vx + x0 / this.zoom,
      this.vy + y0 / this.zoom,
      this.vx + x1 / this.zoom,
      this.vy + y1 / this.zoom,
    );
  }

  setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.overlayDirty = true;
    this.requestRender();
  }

  setSelection(ids: ReadonlyArray<string>): void {
    this.selection = ids;
    this.overlayDirty = true;
    this.requestRender();
  }

  /** Plays keyframe animations. Frames run continuously only while animated nodes are visible. */
  setPlaying(playing: boolean): void {
    const now = performance.now();
    if (playing !== this.scene.isPlaying) {
      if (playing) this.shaderStartedAt = now;
      else this.shaderElapsedMs += now - this.shaderStartedAt;
    }
    this.scene.setPlaying(playing, now);
    this.overlayDirty = true;
    this.requestRender();
  }

  /** Starts a node's hover or press animations (no-op unless playing). */
  triggerAnimation(nodeId: string, trigger: CanvasAnimationTrigger): void {
    if (!this.scene.isPlaying) return;
    if (this.scene.trigger(nodeId, trigger, performance.now())) this.requestRender();
  }

  /** Schedules one frame. Safe to call any number of times. */
  requestRender(): void {
    if (this.raf !== 0 || this.lost || this.destroyed || this.suspended) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  /** Detached editors retain their GPU resources without doing background frame work. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) {
      this.setPlaying(false);
      if (this.raf !== 0) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.texTimer !== null) clearTimeout(this.texTimer);
      this.texTimer = null;
    } else {
      this.requestRender();
    }
  }

  private computeView(scale: number, x0: number, y0: number, width: number, height: number) {
    const view = this.view;
    view.scale = scale;
    view.tx = -x0 * scale;
    view.ty = -y0 * scale;
    view.width = width;
    view.height = height;
    // A small margin keeps antialiased edges of culled quads.
    const margin = 2 / scale;
    view.x0 = x0 - margin;
    view.y0 = y0 - margin;
    view.x1 = x0 + width / scale + margin;
    view.y1 = y0 + height / scale + margin;
    return view;
  }

  private flushUploads() {
    const scene = this.scene;
    const renderer = this.renderer;
    if (scene.fullUpload || scene.instCount > renderer.capacity) {
      scene.refreshDirtyChunks();
      renderer.uploadAll(scene.f32, scene.instCount, scene.instanceCapacity);
      scene.fullUpload = false;
      scene.chunkDirty.fill(0);
      return;
    }
    scene.refreshDirtyChunks();
    const dirty = scene.chunkDirty;
    const chunks = scene.chunkCount;
    let chunk = 0;
    while (chunk < chunks) {
      if (dirty[chunk] !== 1) {
        chunk++;
        continue;
      }
      const start = chunk;
      while (chunk < chunks && dirty[chunk] === 1) dirty[chunk++] = 0;
      renderer.uploadRange(scene.f32, start * CHUNK, Math.min(scene.instCount, chunk * CHUNK));
    }
  }

  private readonly renderFrame = (now: number) => {
    this.raf = 0;
    if (this.lost || this.destroyed || this.suspended) return;
    const start = performance.now();
    const scene = this.scene;
    this.frame++;
    const view = this.computeView(
      this.zoom * this.dpr,
      this.vx,
      this.vy,
      this.canvas.width,
      this.canvas.height,
    );
    let again = false;

    if (scene.building) {
      scene.continueBuild(BUILD_BUDGET_MS);
      if (scene.building) again = true;
      this.texPassNeeded = true;
      this.overlayDirty = true;
    }

    if (scene.isPlaying && scene.tickAnimations(now, view.x0, view.y0, view.x1, view.y1)) {
      again = true;
      this.overlayDirty = true;
    }

    // An export drives texture work itself; frames keep drawing what is resident.
    if (this.texPassNeeded && this.exporting === 0) {
      if (start - this.lastTexPass >= TEXTURE_PASS_INTERVAL_MS) {
        // Prefetch a quarter screen around the view so short pans land on sharp text.
        const padX = (view.x1 - view.x0) * 0.25;
        const padY = (view.y1 - view.y0) * 0.25;
        const passStart = performance.now();
        scene.texturePass(
          view.x0 - padX,
          view.y0 - padY,
          view.x1 + padX,
          view.y1 + padY,
          view.scale,
          this.frame,
          [view.x0, view.y0, view.x1, view.y1],
        );
        if (profileMode()) {
          performance.measure("t3-canvas-texpass", { start: passStart, end: performance.now() });
        }
        this.lastTexPass = start;
        this.texPassNeeded = false;
      } else if (this.texTimer === null) {
        this.texTimer = setTimeout(() => {
          this.texTimer = null;
          this.requestRender();
        }, TEXTURE_PASS_INTERVAL_MS);
      }
    }
    const deadline = start + FRAME_BUDGET_MS;
    if (scene.texturesQueued && this.exporting === 0) {
      const budget = start + TEXTURE_CHECK_BUDGET_MS - performance.now();
      if (budget > 0) scene.drainTextures(budget);
      if (scene.texturesQueued) again = true;
    }
    if (this.exporting === 0) {
      const shaderTime =
        (this.shaderElapsedMs + (scene.isPlaying ? now - this.shaderStartedAt : 0)) / 1000;
      if (scene.shaderFrame(shaderTime, scene.isPlaying, view.x0, view.y0, view.x1, view.y1))
        again = true;
    }
    if (this.textures.hasRunnable && this.exporting === 0) {
      // Leave a slice of the budget for re-encoding what the rasters changed.
      const budget = deadline - 1 - performance.now();
      if (budget <= 0 || this.textures.process(budget)) again = true;
    }
    if (scene.reencodePending) {
      const budget = deadline - performance.now();
      if (budget > 0 && scene.flushReencode(budget, REENCODE_MAX_CHUNKS)) {
        this.overlayDirty = true;
      }
      if (scene.reencodePending) again = true;
    }
    this.flushUploads();
    if (this.overlayDirty) {
      // One CSS px, so outlines stay crisp on pixel-aligned edges at any DPR.
      scene.setOverlay(this.hover, this.selection, this.selectionColor, this.dpr);
      this.renderer.uploadOverlay(scene.overlayF32, scene.overlayCount);
      this.overlayDirty = false;
    }

    this.textures.flushTable();
    for (const { error } of this.textures.shaderErrors()) {
      if (this.reportedErrors.has(error)) continue;
      this.reportedErrors.add(error);
      this.onError?.(error);
    }
    const rangeCount = scene.cull(view.x0, view.y0, view.x1, view.y1, this.draw);
    const prepared = performance.now();

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    view.flipY = 1;
    this.renderer.begin(view, this.background, this.atlas.texture, this.textures.tableTexture);
    this.drawRanges(this.draw.ranges, rangeCount, null, view, true);
    this.renderer.drawOverlay(scene.overlayCount);
    this.renderer.end();

    const end = performance.now();
    this.lastFrameMs = end - start;
    this.frameTimes[this.frameHead] = end;
    this.frameHead = (this.frameHead + 1) % this.frameTimes.length;
    const profile = profileMode();
    if (profile) {
      performance.measure("t3-canvas-frame", { start, end });
      performance.measure("t3-canvas-prep", { start, end: prepared });
      if (profile === "sync") {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probe);
        performance.measure("t3-canvas-frame-gpu", { start, end: performance.now() });
      }
    }
    if (again) this.requestRender();
  };

  /**
   * Draws instance ranges in paint order. Effect subtrees (group opacity,
   * layer blur) inside them go through an offscreen layer and composite onto
   * `target`; past the per-frame layer cap, or without `layers`, they draw
   * directly with their opacity.
   */
  private drawRanges(
    ranges: Int32Array,
    count: number,
    target: WebGLFramebuffer | null,
    view: ViewUniforms,
    layers: boolean,
    isolateRange = false,
  ) {
    const renderer = this.renderer;
    const fxCount = this.scene.collectEffects(this.fx);
    if (fxCount === 0 || !layers) {
      for (let k = 0; k < count; k++) renderer.drawRange(ranges[k * 2]!, ranges[k * 2 + 1]!);
      return;
    }
    const spans = this.fx.spans;
    if (this.fxDrawn.length < fxCount) this.fxDrawn = new Uint8Array(fxCount * 2);
    const drawn = this.fxDrawn;
    drawn.fill(0, 0, fxCount);
    let budget = layers ? (target === null ? MAX_EFFECT_LAYERS : Infinity) : 0;
    for (let k = 0; k < count; k++) {
      let a = ranges[k * 2]!;
      const b = ranges[k * 2 + 1]!;
      // First effect ending after `a` (spans are disjoint, so ends are sorted too).
      let lo = 0;
      let hi = fxCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid * 3 + 1]! <= a) lo = mid + 1;
        else hi = mid;
      }
      let i = lo;
      while (a < b) {
        if (i >= fxCount || spans[i * 3]! >= b) {
          renderer.drawRange(a, b);
          break;
        }
        const s = spans[i * 3]!;
        const e = spans[i * 3 + 1]!;
        const index = spans[i * 3 + 2]!;
        // Fallback opacity lives in each instance, so only real compositing
        // layers split a draw range. Thousands of dimmed groups still batch.
        const opacity = this.scene.effectOpacity(index);
        if (
          drawn[i] === 0 &&
          (budget <= 0 ||
            opacity <= 0 ||
            (opacity >= 1 && this.scene.effectBlur(index) * view.scale < 0.5))
        ) {
          i++;
          continue;
        }
        if (s > a) renderer.drawRange(a, s);
        // An effect subtree draws whole the first time any of it is in range.
        if (drawn[i] === 0) {
          drawn[i] = 1;
          if (
            this.drawEffect(
              index,
              isolateRange ? Math.max(s, a) : s,
              isolateRange ? Math.min(e, b) : e,
              target,
              view,
            )
          ) {
            budget--;
          }
        }
        a = Math.max(s, e);
        i++;
      }
    }
  }

  /** Draws one effect subtree. Returns true when it used a layer. */
  private drawEffect(
    index: number,
    start: number,
    end: number,
    target: WebGLFramebuffer | null,
    view: ViewUniforms,
  ): boolean {
    const scene = this.scene;
    const renderer = this.renderer;
    const opacity = scene.effectOpacity(index);
    if (opacity <= 0) return false;
    const blurWorld = scene.effectBlur(index);
    const sigma = blurWorld * view.scale;
    const bounds = this.fxBounds;
    scene.spanBounds(start, end, bounds);
    const halo = blurWorld * 3;
    const x0 = Math.max(0, Math.floor((bounds[0]! - halo) * view.scale + view.tx));
    const x1 = Math.min(view.width, Math.ceil((bounds[2]! + halo) * view.scale + view.tx));
    const y0 = Math.max(0, Math.floor((bounds[1]! - halo) * view.scale + view.ty));
    const y1 = Math.min(view.height, Math.ceil((bounds[3]! + halo) * view.scale + view.ty));
    if (x1 <= x0 || y1 <= y0) return false;
    const box = this.fxBox;
    box.x = x0;
    box.width = x1 - x0;
    box.height = y1 - y0;
    // GL rows count from the bottom unless the view is flipped (exports).
    box.y = view.flipY > 0 ? view.height - y1 : y0;
    this.layers.begin(view.width, view.height, box, sigma);
    renderer.setCompositeLayer(true);
    renderer.drawRange(start, end);
    this.layers.composite(target, box, sigma, opacity);
    renderer.resume();
    renderer.setCompositeLayer(false);
    return true;
  }

  /**
   * Exports a document or subtree at scale px/world unit, capped at 4096 px per side.
   * Raster preparation runs in time slices to keep large exports responsive.
   * Background accepts CSS colors or transparent, defaulting to the light canvas color
   * so output stays independent of the viewer's theme.
   */
  async renderToBlob(
    options: { nodeId?: string; scale?: number; background?: string } = {},
  ): Promise<Blob> {
    if (this.exporting > 0)
      throw new Error("A canvas export is already in progress. Try again when it finishes.");
    this.exporting++;
    try {
      return await this.exportPng(options);
    } finally {
      this.exporting--;
      this.scene.invalidateTexturePass();
      this.texPassNeeded = true;
      this.requestRender();
    }
  }

  private async exportPng(options: {
    nodeId?: string;
    scale?: number;
    background?: string;
  }): Promise<Blob> {
    const scene = this.scene;
    const unavailable = () => this.lost || this.destroyed;
    const finishBuild = async () => {
      while (scene.building) {
        scene.continueBuild(EXPORT_SLICE_MS);
        await yieldToEventLoop();
        if (unavailable()) throw new Error("Canvas context is unavailable");
      }
    };
    await finishBuild();
    const first = scene.paintBounds(options.nodeId);
    if (!first) throw new Error(options.nodeId ? `Unknown node ${options.nodeId}` : "Empty canvas");
    await this.textures.whenDecoded(scene.assetIdsIn(options.nodeId));
    if (unavailable()) throw new Error("Canvas context is unavailable");
    const gl = this.gl;
    const limit = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, EXPORT_MAX_SIDE);
    let scale = options.scale ?? 1;
    const w0 = Math.max(first[2] - first[0], 1e-3);
    const h0 = Math.max(first[3] - first[1], 1e-3);
    const fit = Math.min(
      limit / (w0 * scale),
      limit / (h0 * scale),
      Math.sqrt(EXPORT_MAX_PIXELS / (w0 * h0 * scale * scale)),
    );
    if (fit < 1) scale *= fit;

    // Request rasters at export scale, then work through them in slices, yielding
    // between them so the window keeps painting (with what is already resident).
    this.frame++;
    scene.invalidateTexturePass();
    scene.texturePass(first[0], first[1], first[2], first[3], scale, this.frame);
    const shaderTime =
      (this.shaderElapsedMs + (scene.isPlaying ? performance.now() - this.shaderStartedAt : 0)) /
      1000;
    for (;;) {
      if (scene.texturesQueued) {
        scene.drainTextures(EXPORT_SLICE_MS);
      }
      scene.shaderFrame(shaderTime, false, first[0], first[1], first[2], first[3]);
      const rasterError = this.textures.rasterError();
      if (rasterError) throw new Error(rasterError);
      if (this.textures.pending > 0) this.textures.process(EXPORT_SLICE_MS);
      else if (scene.reencodePending) scene.flushReencode(EXPORT_SLICE_MS);
      else if (!scene.texturesQueued) break;
      await yieldToEventLoop();
      if (unavailable()) throw new Error("Canvas context is unavailable");
    }
    // The document may have changed while yielding.
    await finishBuild();
    scene.flushReencode();
    const bounds = scene.paintBounds(options.nodeId);
    if (!bounds)
      throw new Error(options.nodeId ? `Unknown node ${options.nodeId}` : "Empty canvas");
    const [x0, y0, x1, y1] = bounds;
    const width = Math.max(1, Math.min(limit, Math.ceil((x1 - x0) * scale)));
    const height = Math.max(1, Math.min(limit, Math.ceil((y1 - y0) * scale)));
    this.flushUploads();

    const framebuffer = gl.createFramebuffer();
    const renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
    const view = this.computeView(scale, x0, y0, width, height);
    // Flip so readPixels returns rows top-down.
    view.flipY = -1;
    const background = new Float32Array(4);
    const backdrop = options.background ?? EXPORT_BACKGROUND;
    if (backdrop !== "transparent") toPremultipliedFloats(parseColor(backdrop), background);
    this.textures.flushTable();
    this.renderer.begin(view, background, this.atlas.texture, this.textures.tableTexture);
    const range = options.nodeId ? scene.instanceRange(options.nodeId) : null;
    if (range) {
      this.draw.ranges[0] = range[0];
      this.draw.ranges[1] = range[1];
      this.drawRanges(this.draw.ranges, 1, framebuffer, view, true, true);
    } else {
      const count = scene.cull(view.x0, view.y0, view.x1, view.y1, this.draw);
      this.drawRanges(this.draw.ranges, count, framebuffer, view, true);
    }
    this.renderer.end();
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteRenderbuffer(renderbuffer);
    // Export-sized effect layers are not worth keeping.
    this.layers.release();

    for (let k = 0; k < pixels.length; k += 4) {
      const a = pixels[k + 3]!;
      if (a === 0 || a === 255) continue;
      pixels[k] = (pixels[k]! * 255) / a;
      pixels[k + 1] = (pixels[k + 1]! * 255) / a;
      pixels[k + 2] = (pixels[k + 2]! * 255) / a;
    }
    const image = new ImageData(pixels, width, height);
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d")!.putImageData(image, 0, 0);
      return canvas.convertToBlob({ type: "image/png" });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(image, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed"))),
        "image/png",
      ),
    );
  }

  stats(): CanvasEngineStats {
    const now = performance.now();
    let fps = 0;
    for (const time of this.frameTimes) if (time > 0 && now - time <= 1000) fps++;
    const view = this.view;
    return {
      fps,
      lastFrameMs: this.lastFrameMs,
      visibleNodes: this.scene.countVisible(
        this.vx,
        this.vy,
        this.vx + this.cssWidth / this.zoom,
        this.vy + this.cssHeight / this.zoom,
      ),
      drawCalls: view.width > 0 ? this.renderer.drawCalls : 0,
      loading: this.scene.building,
    };
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  private readonly onContextRestored = () => {
    this.lost = false;
    this.renderer = new Renderer(this.gl);
    this.layers = new EffectLayers(this.gl);
    this.atlas.restore(this.gl);
    this.textures.restore(this.gl);
    this.scene.invalidateTexturePass();
    this.scene.reencodeAll();
    this.texPassNeeded = true;
    this.overlayDirty = true;
    this.requestRender();
  };

  destroy(): void {
    this.destroyed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.texTimer !== null) clearTimeout(this.texTimer);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.listeners.clear();
    this.textures.destroy();
    if (!this.gl.isContextLost()) {
      this.renderer.destroy();
      this.layers.destroy();
      this.atlas.destroy();
      // React can recreate the engine on the same connected canvas during
      // effect replay. Losing that shared context would break the new engine.
      // After a real unmount, release it once React has removed the element.
      queueMicrotask(() => {
        if (!this.canvas.isConnected && !this.gl.isContextLost()) {
          this.gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
      });
    }
  }
}
