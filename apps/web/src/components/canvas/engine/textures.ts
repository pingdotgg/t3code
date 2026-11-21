import type {
  CanvasAsset,
  CanvasGradientStop,
  CanvasImageFit,
  CanvasNode,
  CanvasPaint,
  CanvasStroke,
  CanvasText,
} from "@t3tools/contracts";

import type { AtlasRegion, TextureAtlas } from "./atlas";
import { mixColor, parseColor, premultiply } from "./color";
import type { ImageRasterRequest, ImageRasterResponse } from "./imageRaster.worker";
import type { ShaderPaint, ShaderRasterRequest, ShaderRasterResponse } from "./shaderRaster.worker";

/** Raster scale buckets are powers of two: index 0 = 1/64x ... index 10 = 16x. */
const BUCKET_COUNT = 11;
const BUCKET_BIAS = 6;
const MAX_RASTER = 2046;
/** Rasters above this many texels upload in row strips over several frames. */
const STRIP_TEXELS = 1 << 18;
/** Texels per family-table row; each family uses two texels. */
export const TABLE_WIDTH = 1024;

const bucketScale = (bucket: number) => 2 ** (bucket - BUCKET_BIAS);

/** Smallest bucket whose scale covers `pxPerUnit` (with a little hysteresis). */
export function bucketFor(pxPerUnit: number): number {
  const exponent = Math.ceil(Math.log2(Math.max(pxPerUnit, 1e-6)) - 0.15);
  return Math.min(BUCKET_COUNT - 1, Math.max(0, exponent + BUCKET_BIAS));
}

const KIND_TEXT = 0;
const KIND_PATH = 1;
const KIND_IMAGE = 2;
const KIND_SHADER = 3;

interface TexEntry {
  shaderTime?: number;
  readonly bucket: number;
  readonly region: AtlasRegion;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

interface TextLayout {
  font: string;
  lines: string[];
  widths: number[];
  lineHeight: number;
  ascent: number;
  descent: number;
  width: number;
  /** Top of the first line in local units. */
  top: number;
  boxWidth: number;
}

/**
 * Rasterized content shared by every node with the same source (text and
 * style, path, or image placement). Instances reference a family by `id`; the
 * shader looks up the currently shown atlas entry in the family table, so a
 * new raster updates one table row instead of re-encoding every user.
 */
export interface TexFamily {
  readonly id: number;
  readonly key: string;
  readonly kind: number;
  readonly users: Set<number>;
  readonly entries: Array<TexEntry | undefined>;
  shown: TexEntry | null;
  want: number;
  wantedFrame: number;
  queued: boolean;
  /** Highest useful bucket (larger ones would exceed source resolution or the atlas). */
  maxBucket: number;
  /** Raster rect in node-local units; null until known (images before decode). */
  rect: [number, number, number, number] | null;
  text: CanvasText | null;
  boxW: number;
  boxH: number;
  layout: TextLayout | null;
  path: string | null;
  compiledPath: Path2D | null;
  fills: ReadonlyArray<CanvasPaint> | null;
  strokes: ReadonlyArray<CanvasStroke> | null;
  assetId: string | null;
  fit: CanvasImageFit;
}

export interface Ramp {
  readonly region: AtlasRegion;
  readonly u0: number;
  readonly u1: number;
  readonly v: number;
  readonly users: Set<number>;
}

interface DecodedImage {
  asset: CanvasAsset;
  bitmap: ImageBitmap | null;
  svg: Blob | null;
  failed: boolean;
}

interface ImageRasterJob {
  readonly id: number;
  readonly family: TexFamily;
  readonly source: DecodedImage;
  readonly bucket: number;
  readonly width: number;
  readonly height: number;
  readonly region: AtlasRegion;
  bitmap: ImageBitmap | null;
  running: boolean;
  fallback: boolean;
  /** Worker results include a gutter; native resize fallback results do not. */
  gutter: boolean;
}

interface ShaderState {
  paint: ShaderPaint;
  time: number;
  renderedTime: number;
  visible: boolean;
  error: string | null;
}
interface ShaderJob {
  id: number;
  family: TexFamily;
  bucket: number;
  width: number;
  height: number;
  time: number;
  bitmap: ImageBitmap | null;
  running: boolean;
}

type Scratch = OffscreenCanvas | HTMLCanvasElement;

/** A large raster drawn into the scratch canvas, uploading a strip per frame. */
interface StripUpload {
  readonly family: TexFamily;
  readonly bucket: number;
  readonly region: AtlasRegion;
  readonly pixelW: number;
  readonly pixelH: number;
  /** Next region row to upload. */
  row: number;
}
type Scratch2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const fontMetrics = new Map<string, { ascent: number; descent: number }>();
const wordWidths = new Map<string, Map<string, number>>();
const checkedFonts = new Set<string>();

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
]);

function fontString(text: CanvasText): string {
  const family = text.fontFamily?.trim() || "system-ui";
  const quoted =
    GENERIC_FAMILIES.has(family) || family.includes(",") || family.startsWith('"')
      ? family
      : `"${family}"`;
  return `${text.fontStyle ?? "normal"} ${text.fontWeight ?? 400} ${text.fontSize}px ${quoted}, system-ui, sans-serif`;
}

/** Line height in px: values <= 4 are multipliers, larger values are px. */
export function lineHeightPx(text: CanvasText, natural: number): number {
  const value = text.lineHeight;
  if (value === undefined || value <= 0) return natural;
  return value <= 4 ? value * text.fontSize : value;
}

/** RGBA32F texture: per family `[u0 v0 u1 v1]` then `[layer resident 0 0]`. */
class FamilyTable {
  texture: WebGLTexture | null = null;
  private rows = 8;
  private data = new Float32Array(TABLE_WIDTH * 4 * 8);
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  constructor(private gl: WebGL2RenderingContext) {
    this.create();
  }

  private create() {
    const gl = this.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, TABLE_WIDTH, this.rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.dirtyMin = 0;
    this.dirtyMax = this.rows - 1;
  }

  restore(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.data.fill(0);
    this.create();
  }

  set(id: number, entry: TexEntry | null) {
    const texel = id * 2;
    const row = Math.floor(texel / TABLE_WIDTH);
    if (row >= this.rows) {
      let rows = this.rows;
      while (row >= rows) rows *= 2;
      const data = new Float32Array(TABLE_WIDTH * 4 * rows);
      data.set(this.data);
      this.data = data;
      this.rows = rows;
      this.gl.deleteTexture(this.texture);
      this.create();
    }
    const o = texel * 4;
    const data = this.data;
    data[o] = entry ? entry.u0 : 0;
    data[o + 1] = entry ? entry.v0 : 0;
    data[o + 2] = entry ? entry.u1 : 0;
    data[o + 3] = entry ? entry.v1 : 0;
    data[o + 4] = entry ? entry.region.layer : 0;
    data[o + 5] = entry ? 1 : 0;
    if (row < this.dirtyMin) this.dirtyMin = row;
    if (row > this.dirtyMax) this.dirtyMax = row;
  }

  flush() {
    if (this.dirtyMax < this.dirtyMin) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      this.dirtyMin,
      TABLE_WIDTH,
      this.dirtyMax - this.dirtyMin + 1,
      gl.RGBA,
      gl.FLOAT,
      this.data,
      this.dirtyMin * TABLE_WIDTH * 4,
    );
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  destroy() {
    this.gl.deleteTexture(this.texture);
  }
}

/**
 * Rasterizes text, paths and images into the atlas at power-of-two zoom
 * buckets, on a per-frame time budget. The previously shown bucket stays on
 * screen until the wanted one is ready.
 */
export class TextureCache {
  private readonly families = new Map<string, TexFamily>();
  private readonly familiesByAsset = new Map<string, Set<TexFamily>>();
  private readonly ramps = new Map<string, Ramp>();
  private readonly rampByStops = new WeakMap<ReadonlyArray<CanvasGradientStop>, Ramp>();
  private readonly images = new Map<string, DecodedImage>();
  private readonly imageReservations = new Map<TexFamily, AtlasRegion>();
  private readonly imageJobs = new Map<TexFamily, ImageRasterJob>();
  private readonly activeImageJobs = new Map<number, ImageRasterJob>();
  private imageWorker: Worker | null = null;
  private imageWorkerFailed = false;
  private imageJobId = 0;
  private readonly shaders = new Map<TexFamily, ShaderState>();
  private readonly shaderJobs = new Map<TexFamily, ShaderJob>();
  private readonly capacityFailures = new Map<TexFamily, { bucket: number; frame: number }>();
  private shaderWorker: Worker | null = null;
  private activeShaderJob: ShaderJob | null = null;
  private shaderJobId = 0;
  private destroyed = false;
  private readonly queue: TexFamily[] = [];
  private queueHead = 0;
  private readonly freeIds: number[] = [];
  private nextId = 0;
  private readonly scratch: Scratch;
  private readonly ctx: Scratch2D;
  private readonly rampBytes = new Uint8Array(256 * 4);
  private readonly table: FamilyTable;
  private assets: Readonly<Record<string, CanvasAsset>> = {};
  /** In-flight strip upload; it owns the scratch canvas until done. */
  private upload: StripUpload | null = null;
  /** Frame of the latest visibility pass; atlas pages touched since then are kept. */
  passFrame = 0;

  constructor(
    gl: WebGL2RenderingContext,
    private readonly atlas: TextureAtlas,
    /** A family's raster rect changed (image decoded, font loaded); re-encode its users. */
    private readonly onFamilyChanged: (family: TexFamily) => void,
    private readonly onRampEvicted: (ramp: Ramp) => void,
    private readonly requestFrame: () => void,
  ) {
    this.table = new FamilyTable(gl);
    const size = MAX_RASTER + 2;
    this.scratch = this.makeScratch(size);
    // CPU-backed so uploading a region of it to the atlas is a memcpy, not a GPU readback.
    const ctx = this.scratch.getContext("2d", { willReadFrequently: true }) as Scratch2D | null;
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  private makeScratch(size: number): Scratch {
    return typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement("canvas"), { width: size, height: size });
  }

  get pending() {
    return (
      this.queue.length -
      this.queueHead +
      (this.upload ? 1 : 0) +
      this.imageJobs.size +
      this.shaderJobs.size
    );
  }

  get hasRunnable() {
    return this.queue.length > this.queueHead || this.upload !== null;
  }

  get tableTexture() {
    return this.table.texture;
  }

  flushTable() {
    this.table.flush();
  }

  /** Context restore: every atlas entry is gone. Families and decoded images stay. */
  restore(gl: WebGL2RenderingContext) {
    this.clearImageJobs();
    this.clearShaderJobs();
    this.capacityFailures.clear();
    this.table.restore(gl);
    for (const family of this.families.values()) {
      family.entries.fill(undefined);
      family.shown = null;
      family.queued = false;
    }
    this.queue.length = 0;
    this.queueHead = 0;
    this.upload = null;
    this.ramps.clear();
  }

  private newFamily(key: string, kind: number, boxW: number, boxH: number): TexFamily {
    if (this.families.size > 50_000) this.sweep();
    const family: TexFamily = {
      id: this.freeIds.pop() ?? this.nextId++,
      key,
      kind,
      users: new Set(),
      entries: Array.from({ length: BUCKET_COUNT }, () => undefined),
      shown: null,
      want: -1,
      wantedFrame: -1,
      queued: false,
      maxBucket: BUCKET_COUNT - 1,
      rect: null,
      text: null,
      boxW,
      boxH,
      layout: null,
      path: null,
      compiledPath: null,
      fills: null,
      strokes: null,
      assetId: null,
      fit: "fill",
    };
    this.table.set(family.id, null);
    this.families.set(key, family);
    return family;
  }

  private sweep() {
    for (const [key, family] of this.families) {
      if (family.users.size > 0) continue;
      this.families.delete(key);
      this.discardImageJob(family);
      this.discardShaderJob(family);
      this.shaders.delete(family);
      this.capacityFailures.delete(family);
      this.freeIds.push(family.id);
      if (family.assetId !== null) this.familiesByAsset.get(family.assetId)?.delete(family);
    }
  }

  textFamily(text: CanvasText, w: number, h: number): TexFamily {
    const sizing = text.sizing ?? "auto-width";
    const align = text.align ?? "left";
    const valign = text.verticalAlign ?? "top";
    const wrapW = sizing === "auto-width" ? (align === "left" ? -1 : w) : w;
    const boxH = sizing === "fixed" || valign !== "top" ? h : -1;
    const key = `t|${text.content}|${fontString(text)}|${text.lineHeight ?? ""}|${text.letterSpacing ?? 0}|${align}|${valign}|${sizing}|${wrapW}|${boxH}`;
    const existing = this.families.get(key);
    if (existing) return existing;
    const family = this.newFamily(key, KIND_TEXT, w, h);
    family.text = text;
    this.layoutText(family);
    this.ensureFont(family);
    return family;
  }

  private ensureFont(family: TexFamily) {
    if (typeof document === "undefined" || !document.fonts || !family.text) return;
    const font = fontString(family.text);
    // One check (or load) per font string; a load re-lays out every family using it.
    if (checkedFonts.has(font)) return;
    checkedFonts.add(font);
    if (document.fonts.check(font)) return;
    document.fonts.load(font).then(
      (faces) => {
        if (faces.length === 0) return;
        fontMetrics.delete(font);
        wordWidths.delete(font);
        for (const candidate of this.families.values()) {
          if (candidate.kind !== KIND_TEXT || candidate.layout?.font !== font) continue;
          // Keep showing the old raster until the re-raster lands.
          candidate.entries.fill(undefined);
          this.layoutText(candidate);
          this.onFamilyChanged(candidate);
        }
        this.requestFrame();
      },
      () => undefined,
    );
  }

  pathFamily(node: CanvasNode, w: number, h: number): TexFamily {
    const path = node.path ?? `M0 0L${w} ${h}`;
    const key = `p|${path}|${w}|${h}|${paintKey(node.fills)}|${strokeKey(node.strokes)}`;
    const existing = this.families.get(key);
    if (existing) return existing;
    const family = this.newFamily(key, KIND_PATH, w, h);
    family.path = path;
    family.fills = node.fills ?? null;
    family.strokes = node.strokes ?? null;
    let stroke = 0;
    for (const value of family.strokes ?? []) {
      stroke = Math.max(stroke, value.width * (value.align === "outside" ? 2 : 1));
    }
    const pad = Math.ceil(stroke) + 2;
    family.rect = [-pad, -pad, w + pad * 2, h + pad * 2];
    family.maxBucket = maxBucketFor(family.rect[2], family.rect[3]);
    return family;
  }

  imageFamily(assetId: string, fit: CanvasImageFit, w: number, h: number): TexFamily {
    const key = `i|${assetId}|${fit}|${w}|${h}`;
    const existing = this.families.get(key);
    if (existing) return existing;
    const family = this.newFamily(key, KIND_IMAGE, w, h);
    family.assetId = assetId;
    family.fit = fit;
    let set = this.familiesByAsset.get(assetId);
    if (!set) {
      set = new Set();
      this.familiesByAsset.set(assetId, set);
    }
    set.add(family);
    this.placeImage(family);
    return family;
  }

  shaderFamily(paint: ShaderPaint, w: number, h: number): TexFamily {
    const key = `s|${JSON.stringify(paint)}|${w}|${h}`;
    const existing = this.families.get(key);
    if (existing) return existing;
    const family = this.newFamily(key, KIND_SHADER, w, h);
    family.rect = [0, 0, w, h];
    family.maxBucket = maxBucketFor(w, h);
    this.shaders.set(family, { paint, time: 0, renderedTime: NaN, visible: true, error: null });
    return family;
  }

  /** Time is held when paused; only visible time-dependent fills request frames. */
  shaderFrame(visible: ReadonlySet<TexFamily>, timeSeconds: number, playing: boolean): boolean {
    let animated = false;
    for (const [family, state] of this.shaders) {
      state.visible = visible.has(family);
      if (!state.visible || state.error || this.capacityBlocked(family)) {
        this.discardShaderJob(family);
        continue;
      }
      if (state.paint.timeUniform) {
        state.time = timeSeconds;
        animated ||= playing;
      }
      const entry = family.entries[family.want];
      if (entry?.region.valid && entry.shaderTime === state.time) this.discardShaderJob(family);
      else if (!this.shaderJobs.has(family)) this.queueImageFamily(family);
    }
    this.pumpShaderJobs();
    return animated;
  }

  shaderErrors(): ReadonlyArray<{ familyId: number; error: string }> {
    const errors: { familyId: number; error: string }[] = [];
    for (const [family, state] of this.shaders)
      if (state.error) errors.push({ familyId: family.id, error: state.error });
    return errors;
  }

  private capacityBlocked(family: TexFamily) {
    const failure = this.capacityFailures.get(family);
    return failure?.frame === this.passFrame && failure.bucket === family.want;
  }

  /** An export must fail explicitly instead of returning missing paints or retrying forever. */
  rasterError(): string | null {
    for (const [family] of this.capacityFailures) {
      if (family.users.size > 0 && this.capacityBlocked(family))
        // oxlint-disable-next-line t3code/no-untranslated-copy -- thrown export error, returned to the agent that requested the screenshot
        return "Canvas texture capacity exceeded. Export a smaller selection or use a lower scale.";
    }
    for (const state of this.shaders.values())
      // oxlint-disable-next-line t3code/no-untranslated-copy -- thrown export error, returned to the agent that requested the screenshot
      if (state.visible && state.error) return `Canvas shader failed: ${state.error}`;
    return null;
  }

  /** Re-decodes assets whose object identity changed. */
  syncAssets(assets: Readonly<Record<string, CanvasAsset>>) {
    if (assets === this.assets) return;
    this.assets = assets;
    for (const [assetId, decoded] of this.images) {
      if (assets[assetId] === decoded.asset) continue;
      decoded.bitmap?.close();
      this.images.delete(assetId);
      for (const family of this.familiesByAsset.get(assetId) ?? []) {
        this.discardImageJob(family);
        family.entries.fill(undefined);
        this.show(family, null);
        family.rect = null;
        this.placeImage(family);
        this.onFamilyChanged(family);
      }
    }
  }

  private naturalSize(assetId: string): [number, number] | null {
    const decoded = this.images.get(assetId);
    if (decoded?.bitmap) return [decoded.bitmap.width, decoded.bitmap.height];
    const asset = this.assets[assetId];
    if (asset?.width && asset.height) return [asset.width, asset.height];
    return null;
  }

  private placeImage(family: TexFamily) {
    const natural = this.naturalSize(family.assetId!);
    if (!natural) {
      this.decode(family.assetId!);
      return;
    }
    const [nw, nh] = natural;
    const { boxW: w, boxH: h } = family;
    if (family.fit === "tile") {
      family.rect = [0, 0, nw, nh];
    } else if (family.fit === "stretch") {
      family.rect = [0, 0, w, h];
    } else {
      const s = family.fit === "fit" ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
      family.rect = [(w - nw * s) / 2, (h - nh * s) / 2, nw * s, nh * s];
    }
    const rect = family.rect;
    // Past the source resolution a bigger bucket only wastes atlas space.
    const sourceBucket = this.assets[family.assetId!]?.mimeType?.includes("svg")
      ? BUCKET_COUNT - 1
      : bucketFor(Math.max(nw / rect[2], nh / rect[3]));
    family.maxBucket = Math.min(sourceBucket, maxBucketFor(rect[2], rect[3]));
  }

  private decode(assetId: string) {
    if (this.images.has(assetId)) return;
    const asset = this.assets[assetId];
    if (!asset) return;
    const decoded: DecodedImage = { asset, bitmap: null, svg: null, failed: false };
    this.images.set(assetId, decoded);
    fetch(asset.url)
      .then((response) => response.blob())
      .then(async (blob) => {
        if (blob.type.includes("svg") || asset.mimeType?.includes("svg")) decoded.svg = blob;
        try {
          return await createImageBitmap(blob);
        } catch (error) {
          if (!decoded.svg) throw error;
          const url = URL.createObjectURL(blob);
          try {
            const image = new Image();
            image.src = url;
            await image.decode();
            return await createImageBitmap(image);
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      })
      .then(
        (bitmap) => {
          if (this.images.get(assetId) !== decoded) {
            bitmap.close();
            return;
          }
          decoded.bitmap = bitmap;
          for (const family of this.familiesByAsset.get(assetId) ?? []) {
            const before = family.rect;
            this.placeImage(family);
            if (family.rect !== before) this.onFamilyChanged(family);
          }
          this.requestFrame();
        },
        () => {
          decoded.failed = true;
          if (this.images.get(assetId) === decoded)
            for (const family of this.familiesByAsset.get(assetId) ?? [])
              this.discardImageJob(family);
        },
      );
  }

  /** Settles once every image asset in `assetIds` decoded or failed. */
  async whenDecoded(assetIds: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const assetId of assetIds) {
      this.decode(assetId);
      const decoded = this.images.get(assetId);
      if (!decoded || decoded.bitmap || decoded.failed) continue;
      waits.push(
        new Promise<void>((resolve) => {
          const poll = () => {
            if (decoded.bitmap || decoded.failed || this.images.get(assetId) !== decoded) resolve();
            else setTimeout(poll, 16);
          };
          poll();
        }),
      );
    }
    await Promise.all(waits);
  }

  private show(family: TexFamily, entry: TexEntry | null) {
    if (family.shown === entry) return;
    family.shown = entry;
    this.table.set(family.id, entry);
  }

  /** Nearest resident entry to the wanted bucket, sharper first. */
  private best(family: TexFamily): TexEntry | null {
    const want = family.want < 0 ? family.maxBucket : family.want;
    let best: TexEntry | null = null;
    let bestDistance = Infinity;
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const entry = family.entries[bucket];
      if (!entry || !entry.region.valid) continue;
      const distance = Math.abs(bucket - want) * 2 + (bucket < want ? 1 : 0);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Protects displayed content before the visibility checks drain in slices. */
  pin(family: TexFamily) {
    family.wantedFrame = this.passFrame;
    if (this.upload?.family === family && this.upload.region.valid)
      this.atlas.touch(this.upload.region, this.passFrame);
    const image = this.imageJobs.get(family);
    if (image?.region.valid) this.atlas.touch(image.region, this.passFrame);
    const reservation = this.imageReservations.get(family);
    if (reservation?.valid) this.atlas.touch(reservation, this.passFrame);
    const entry = family.shown?.region.valid ? family.shown : this.best(family);
    if (entry) this.atlas.touch(entry.region, this.passFrame);
  }

  /** A visible user wants `bucket`: show it if resident, else queue a raster. */
  want(family: TexFamily, bucket: number) {
    const target = Math.min(bucket, family.maxBucket);
    family.want = target;
    family.wantedFrame = this.passFrame;
    const entry = family.entries[target];
    if (entry && entry.region.valid) {
      if (this.imageJobs.has(family) || this.imageReservations.has(family)) {
        this.discardImageJob(family);
        this.pumpImageJobs();
      }
      this.atlas.touch(entry.region, this.passFrame);
      this.show(family, entry);
      const shader = this.shaders.get(family);
      if (shader && entry.shaderTime !== shader.time && !this.shaderJobs.has(family))
        this.queueImageFamily(family);
      return;
    }
    if (!family.shown?.region.valid) this.show(family, this.best(family));
    this.pin(family);
    if (this.capacityBlocked(family)) return;
    if (this.imageJobs.has(family)) return;
    if (!family.queued) {
      family.queued = true;
      this.queue.push(family);
    }
  }

  /**
   * Runs queued raster jobs until `budgetMs` elapses (at least one step).
   * Large rasters upload in strips across calls. Returns true when work remains.
   */
  process(budgetMs: number): boolean {
    const start = performance.now();
    if (this.upload && !this.continueUpload(start, budgetMs)) return true;
    while (this.queueHead < this.queue.length) {
      if (performance.now() - start > budgetMs) break;
      // Visibility checks enqueue the screen before its prefetch margin.
      const family = this.queue[this.queueHead++]!;
      family.queued = false;
      const bucket = family.want;
      if (bucket < 0 || family.users.size === 0 || family.wantedFrame !== this.passFrame) {
        this.discardImageJob(family);
        this.discardShaderJob(family);
        this.pumpImageJobs();
        continue;
      }
      if (this.capacityBlocked(family)) continue;
      const existing = family.entries[bucket];
      const shader = this.shaders.get(family);
      if (existing && existing.region.valid && (!shader || existing.shaderTime === shader.time))
        continue;
      const entry = this.raster(family, bucket);
      if (entry) this.install(family, bucket, entry);
      if (this.upload && !this.continueUpload(start, budgetMs)) return true;
    }
    if (this.queueHead === this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    }
    return this.hasRunnable;
  }

  private install(family: TexFamily, bucket: number, entry: TexEntry) {
    const shader = this.shaders.get(family);
    if (shader) entry.shaderTime = shader.renderedTime;
    family.entries[bucket] = entry;
    entry.region.onEvict = () => {
      if (family.entries[bucket] === entry) family.entries[bucket] = undefined;
      if (family.shown === entry) this.show(family, this.best(family));
    };
    if (family.want === bucket || !family.shown) this.show(family, entry);
  }

  /** Uploads strips of the in-flight raster within the budget. Returns true once it is done. */
  private continueUpload(start: number, budgetMs: number): boolean {
    const job = this.upload!;
    const { family, region } = job;
    if (family.wantedFrame !== this.passFrame) {
      this.releaseReservation(region);
      this.upload = null;
      return true;
    }
    if (!region.valid) {
      // Evicted mid-upload: raster again when still wanted.
      this.upload = null;
      if (!family.queued) {
        family.queued = true;
        this.queue.push(family);
      }
      return true;
    }
    const rows = region.h;
    const step = Math.max(8, Math.floor(STRIP_TEXELS / region.w));
    do {
      const count = Math.min(step, rows - job.row);
      this.atlas.uploadCanvasRows(region, this.scratch, job.row, count);
      job.row += count;
    } while (job.row < rows && performance.now() - start < budgetMs);
    if (job.row < rows) return false;
    this.upload = null;
    this.install(family, job.bucket, this.entryFor(job.bucket, region, job.pixelW, job.pixelH));
    return true;
  }

  private raster(family: TexFamily, bucket: number): TexEntry | null {
    switch (family.kind) {
      case KIND_TEXT:
        return this.rasterText(family, bucket);
      case KIND_PATH:
        return this.rasterPath(family, bucket);
      case KIND_SHADER:
        return this.rasterShader(family, bucket);
      default:
        return this.rasterImage(family, bucket);
    }
  }

  /**
   * Uploads the scratch raster (with its 1px gutter) to the atlas. Large ones
   * start a strip upload and return null until it finishes.
   */
  private commit(
    family: TexFamily,
    bucket: number,
    pixelW: number,
    pixelH: number,
    reserved?: AtlasRegion,
  ): TexEntry | null {
    const existing = family.kind === KIND_SHADER ? family.entries[bucket]?.region : undefined;
    if (reserved && (reserved.w !== pixelW + 2 || reserved.h !== pixelH + 2)) {
      this.releaseReservation(reserved);
    }
    const region = reserved?.valid
      ? reserved
      : existing?.valid && existing.w === pixelW + 2 && existing.h === pixelH + 2
        ? existing
        : this.atlas.allocate(pixelW + 2, pixelH + 2, this.passFrame);
    if (!region) {
      this.capacityFailures.set(family, { bucket, frame: this.passFrame });
      return null;
    }
    this.capacityFailures.delete(family);
    if (region.w * region.h > STRIP_TEXELS) {
      this.upload = { family, bucket, region, pixelW, pixelH, row: 0 };
      return null;
    }
    this.atlas.uploadCanvasRows(region, this.scratch, 0, region.h);
    return this.entryFor(bucket, region, pixelW, pixelH);
  }

  private entryFor(bucket: number, region: AtlasRegion, pixelW: number, pixelH: number): TexEntry {
    const size = this.atlas.size;
    return {
      bucket,
      region,
      u0: (region.x + 1) / size,
      v0: (region.y + 1) / size,
      u1: (region.x + 1 + pixelW) / size,
      v1: (region.y + 1 + pixelH) / size,
    };
  }

  private prepare(pixelW: number, pixelH: number) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, pixelW + 2, pixelH + 2);
  }

  private layoutText(family: TexFamily) {
    const text = family.text!;
    const ctx = this.ctx;
    const font = fontString(text);
    ctx.font = font;
    setLetterSpacing(ctx, text.letterSpacing ?? 0);
    let metrics = fontMetrics.get(font);
    if (!metrics) {
      const measured = ctx.measureText("Mg");
      metrics = {
        ascent: measured.fontBoundingBoxAscent || text.fontSize * 0.8,
        descent: measured.fontBoundingBoxDescent || text.fontSize * 0.2,
      };
      fontMetrics.set(font, metrics);
    }
    let widths = wordWidths.get(font);
    if (!widths) {
      widths = new Map();
      wordWidths.set(font, widths);
    }
    const spacing = text.letterSpacing ?? 0;
    const measure = (value: string) => {
      const key = spacing === 0 ? value : `${spacing}|${value}`;
      let width = widths.get(key);
      if (width === undefined) {
        width = ctx.measureText(value).width;
        if (widths.size > 20_000) widths.clear();
        widths.set(key, width);
      }
      return width;
    };
    const sizing = text.sizing ?? "auto-width";
    const maxWidth = sizing === "auto-width" ? Infinity : Math.max(family.boxW, 1);
    const lines: string[] = [];
    const lineWidths: number[] = [];
    for (const paragraph of text.content.split("\n")) {
      const full = measure(paragraph);
      if (full <= maxWidth + 0.5) {
        lines.push(paragraph);
        lineWidths.push(full);
        continue;
      }
      let line = "";
      let width = 0;
      for (const token of paragraph.split(/(\s+)/)) {
        if (token.length === 0) continue;
        const tokenWidth = measure(token);
        const blank = token.trim().length === 0;
        if (line.length === 0 || blank || width + tokenWidth <= maxWidth + 0.5) {
          if (line.length === 0 && blank) continue;
          line += token;
          width += tokenWidth;
          continue;
        }
        const trimmed = line.trimEnd();
        lines.push(trimmed);
        lineWidths.push(measure(trimmed));
        line = token;
        width = tokenWidth;
      }
      const trimmed = line.trimEnd();
      lines.push(trimmed);
      lineWidths.push(measure(trimmed));
    }
    const lineHeight = lineHeightPx(text, metrics.ascent + metrics.descent);
    const textHeight = lines.length * lineHeight;
    let width = 0;
    for (const value of lineWidths) width = Math.max(width, value);
    const boxWidth = sizing === "auto-width" ? Math.max(family.boxW, width) : family.boxW;
    const boxHeight = sizing === "auto-height" ? Math.max(family.boxH, textHeight) : family.boxH;
    const valign = text.verticalAlign ?? "top";
    const top =
      valign === "middle"
        ? (boxHeight - textHeight) / 2
        : valign === "bottom"
          ? boxHeight - textHeight
          : 0;
    const pad = Math.ceil(text.fontSize * 0.25) + 1;
    let rect: [number, number, number, number] = [0, 0, boxWidth, family.boxH];
    if (sizing !== "fixed") {
      const rx = Math.min(0, boxWidth - width) - pad;
      const ry = Math.min(0, top) - pad;
      rect = [
        rx,
        ry,
        Math.max(boxWidth, width) - rx + pad,
        Math.max(family.boxH, top + textHeight) - ry + pad,
      ];
    }
    family.layout = {
      font,
      lines,
      widths: lineWidths,
      lineHeight,
      ascent: metrics.ascent,
      descent: metrics.descent,
      width,
      top,
      boxWidth,
    };
    family.rect = rect;
    family.maxBucket = maxBucketFor(rect[2], rect[3]);
  }

  private rasterText(family: TexFamily, bucket: number): TexEntry | null {
    const text = family.text!;
    const layout = family.layout!;
    const [rx, ry, rw, rh] = family.rect!;
    const scale = Math.min(bucketScale(bucket), MAX_RASTER / Math.max(rw, rh, 1));
    const pixelW = Math.max(1, Math.ceil(rw * scale));
    const pixelH = Math.max(1, Math.ceil(rh * scale));
    this.prepare(pixelW, pixelH);
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 1 - rx * scale, 1 - ry * scale);
    const fixed = (text.sizing ?? "auto-width") === "fixed";
    if (fixed) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, family.boxW, family.boxH);
      ctx.clip();
    }
    ctx.font = layout.font;
    setLetterSpacing(ctx, text.letterSpacing ?? 0);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "alphabetic";
    const align = text.align ?? "left";
    const baselineOffset =
      (layout.lineHeight - (layout.ascent + layout.descent)) / 2 + layout.ascent;
    for (let line = 0; line < layout.lines.length; line++) {
      const content = layout.lines[line]!;
      const lineWidth = layout.widths[line]!;
      const y = layout.top + line * layout.lineHeight + baselineOffset;
      if (align === "justify" && line < layout.lines.length - 1) {
        drawJustified(ctx, content, layout.boxWidth, y);
        continue;
      }
      const x =
        align === "center"
          ? (layout.boxWidth - lineWidth) / 2
          : align === "right"
            ? layout.boxWidth - lineWidth
            : 0;
      ctx.fillText(content, x, y);
    }
    if (fixed) ctx.restore();
    return this.commit(family, bucket, pixelW, pixelH);
  }

  private rasterPath(family: TexFamily, bucket: number): TexEntry | null {
    const rect = family.rect!;
    const scale = Math.min(bucketScale(bucket), MAX_RASTER / Math.max(rect[2], rect[3], 1));
    const pixelW = Math.max(1, Math.ceil(rect[2] * scale));
    const pixelH = Math.max(1, Math.ceil(rect[3] * scale));
    this.prepare(pixelW, pixelH);
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 1 - rect[0] * scale, 1 - rect[1] * scale);
    let path: Path2D;
    try {
      path = family.compiledPath ??= new Path2D(family.path ?? "");
    } catch {
      return null;
    }
    for (const fill of family.fills ?? []) {
      const style = canvasPaint(ctx, fill, family.boxW, family.boxH);
      if (style === null) continue;
      ctx.fillStyle = style;
      ctx.fill(path);
    }
    for (const stroke of family.strokes ?? []) {
      if (stroke.width <= 0) continue;
      ctx.save();
      ctx.strokeStyle = cssColor(parseColor(stroke.color));
      ctx.setLineDash(stroke.dash ? [...stroke.dash] : []);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (stroke.align === "inside") {
        ctx.clip(path);
        ctx.lineWidth = stroke.width * 2;
      } else if (stroke.align === "outside") {
        const outside = new Path2D();
        outside.rect(rect[0], rect[1], rect[2], rect[3]);
        outside.addPath(path);
        ctx.clip(outside, "evenodd");
        ctx.lineWidth = stroke.width * 2;
      } else {
        ctx.lineWidth = stroke.width;
      }
      ctx.stroke(path);
      ctx.restore();
    }
    return this.commit(family, bucket, pixelW, pixelH);
  }

  private discardShaderJob(family: TexFamily) {
    this.shaderJobs.get(family)?.bitmap?.close();
    this.shaderJobs.delete(family);
  }

  private clearShaderJobs() {
    for (const job of this.shaderJobs.values()) job.bitmap?.close();
    this.shaderJobs.clear();
    this.activeShaderJob = null;
    this.shaderWorker?.terminate();
    this.shaderWorker = null;
    for (const state of this.shaders.values()) {
      state.renderedTime = NaN;
      state.error = null;
    }
  }

  private failShaderJob(job: ShaderJob, error: string) {
    this.discardShaderJob(job.family);
    const state = this.shaders.get(job.family);
    if (state) {
      state.error = error;
      this.onFamilyChanged(job.family);
    }
    if (this.activeShaderJob === job) this.activeShaderJob = null;
    this.requestFrame();
  }

  private pumpShaderJobs() {
    for (const [family] of this.shaderJobs) {
      if (family.wantedFrame !== this.passFrame) this.discardShaderJob(family);
    }
    if (this.destroyed || this.activeShaderJob) return;
    for (const job of this.shaderJobs.values()) if (job.bitmap) return;
    for (const job of this.shaderJobs.values()) {
      const state = this.shaders.get(job.family);
      if (
        !state ||
        state.error ||
        !state.visible ||
        job.family.users.size === 0 ||
        job.bucket !== job.family.want
      ) {
        this.discardShaderJob(job.family);
        if (state?.visible && !state.error && job.family.users.size > 0)
          this.queueImageFamily(job.family);
        continue;
      }
      this.activeShaderJob = job;
      job.running = true;
      try {
        if (!this.shaderWorker) {
          const worker = new Worker(new URL("./shaderRaster.worker.ts", import.meta.url), {
            type: "module",
          });
          worker.addEventListener("message", (event: MessageEvent<ShaderRasterResponse>) => {
            const response = event.data;
            const active = this.activeShaderJob;
            if (this.shaderWorker !== worker || !active || active.id !== response.id) {
              if ("bitmap" in response) response.bitmap.close();
              return;
            }
            this.activeShaderJob = null;
            if (this.shaderJobs.get(active.family) !== active) {
              if ("bitmap" in response) response.bitmap.close();
            } else if ("error" in response) this.failShaderJob(active, response.error);
            else {
              active.bitmap = response.bitmap;
              this.queueImageFamily(active.family);
              this.requestFrame();
            }
            this.pumpShaderJobs();
          });
          const onError = () => {
            if (this.shaderWorker !== worker) return;
            worker.terminate();
            this.shaderWorker = null;
            this.activeShaderJob = null;
            for (const pending of this.shaderJobs.values())
              this.failShaderJob(pending, "Shader worker is unavailable");
          };
          worker.addEventListener("error", onError);
          worker.addEventListener("messageerror", onError);
          this.shaderWorker = worker;
        }
        this.shaderWorker.postMessage(
          {
            id: job.id,
            paint: state.paint,
            width: job.width,
            height: job.height,
            time: job.time,
          } satisfies ShaderRasterRequest,
          [],
        );
      } catch (error) {
        this.failShaderJob(
          job,
          error instanceof Error ? error.message : "Shader worker is unavailable",
        );
        continue;
      }
      return;
    }
  }

  private rasterShader(family: TexFamily, bucket: number): TexEntry | null {
    const state = this.shaders.get(family);
    if (!state || state.error || !state.visible) return null;
    const job = this.shaderJobs.get(family);
    if (job?.bitmap) {
      this.shaderJobs.delete(family);
      if (job.bucket !== bucket) {
        job.bitmap.close();
        this.queueImageFamily(family);
        this.pumpShaderJobs();
        return null;
      }
      this.prepare(job.width, job.height);
      const ctx = this.ctx;
      ctx.drawImage(job.bitmap, 1, 1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(job.bitmap, 0, 0, job.width, 1, 1, 0, job.width, 1);
      ctx.drawImage(job.bitmap, 0, job.height - 1, job.width, 1, 1, job.height + 1, job.width, 1);
      ctx.drawImage(this.scratch, 1, 0, 1, job.height + 2, 0, 0, 1, job.height + 2);
      ctx.drawImage(
        this.scratch,
        job.width,
        0,
        1,
        job.height + 2,
        job.width + 1,
        0,
        1,
        job.height + 2,
      );
      ctx.imageSmoothingEnabled = true;
      job.bitmap.close();
      state.renderedTime = job.time;
      const entry = this.commit(family, bucket, job.width, job.height);
      if (job.time !== state.time) this.queueImageFamily(family);
      this.pumpShaderJobs();
      return entry;
    }
    if (!job) {
      const scale = bucketScale(bucket);
      const fit = Math.min(1, MAX_RASTER / Math.max(family.boxW * scale, family.boxH * scale, 1));
      this.shaderJobs.set(family, {
        id: ++this.shaderJobId,
        family,
        bucket,
        width: Math.max(1, Math.floor(family.boxW * scale * fit)),
        height: Math.max(1, Math.floor(family.boxH * scale * fit)),
        time: state.time,
        bitmap: null,
        running: false,
      });
      this.pumpShaderJobs();
    }
    return null;
  }

  /** Uninstalled pixels can be reclaimed immediately, even in the same pass. */
  private releaseReservation(region: AtlasRegion) {
    region.valid = false;
    region.lastUsed = -1;
    region.onEvict = null;
  }

  private discardImageJob(family: TexFamily) {
    const job = this.imageJobs.get(family);
    job?.bitmap?.close();
    if (job) this.releaseReservation(job.region);
    this.imageJobs.delete(family);
    const reservation = this.imageReservations.get(family);
    if (reservation) this.releaseReservation(reservation);
    this.imageReservations.delete(family);
  }

  private clearImageJobs() {
    for (const family of this.imageJobs.keys()) this.discardImageJob(family);
    for (const family of this.imageReservations.keys()) this.discardImageJob(family);
    this.activeImageJobs.clear();
    this.imageWorker?.terminate();
    this.imageWorker = null;
  }

  private queueImageFamily(family: TexFamily) {
    if (
      family.queued ||
      family.users.size === 0 ||
      family.wantedFrame !== this.passFrame ||
      this.families.get(family.key) !== family
    )
      return;
    family.queued = true;
    this.queue.push(family);
  }

  private finishImageJob(job: ImageRasterJob, bitmap: ImageBitmap | null, gutter: boolean) {
    if (this.activeImageJobs.get(job.id) !== job) {
      bitmap?.close();
      return;
    }
    this.activeImageJobs.delete(job.id);
    const current =
      !this.destroyed &&
      this.imageJobs.get(job.family) === job &&
      this.images.get(job.family.assetId!) === job.source;
    if (
      !current ||
      job.family.want !== job.bucket ||
      job.family.users.size === 0 ||
      job.family.wantedFrame !== this.passFrame
    ) {
      bitmap?.close();
      if (current) {
        this.discardImageJob(job.family);
        this.queueImageFamily(job.family);
      }
    } else if (bitmap) {
      job.bitmap = bitmap;
      job.gutter = gutter;
      this.queueImageFamily(job.family);
    } else {
      this.discardImageJob(job.family);
    }
    this.pumpImageJobs();
    if (!this.destroyed && this.hasRunnable) this.requestFrame();
  }

  private resizeImageFallback(job: ImageRasterJob) {
    if (job.fallback) return;
    job.fallback = true;
    if (job.source.svg) {
      this.resizeSvgFallback(job).then(
        (bitmap) => this.finishImageJob(job, bitmap, false),
        () => this.finishImageJob(job, null, false),
      );
      return;
    }
    const source = job.source.bitmap;
    if (!source) {
      this.finishImageJob(job, null, false);
      return;
    }
    createImageBitmap(source, {
      resizeWidth: job.width,
      resizeHeight: job.height,
      resizeQuality: "high",
    }).then(
      (bitmap) => this.finishImageJob(job, bitmap, false),
      () => this.finishImageJob(job, null, false),
    );
  }

  private async resizeSvgFallback(job: ImageRasterJob) {
    const url = URL.createObjectURL(job.source.svg!);
    try {
      // Rasterize the vector at the requested size instead of enlarging its
      // intrinsic bitmap. Chromium cannot decode SVG in createImageBitmap.
      const image = new Image(job.width, job.height);
      image.src = url;
      await image.decode();
      const canvas = this.makeScratch(Math.max(job.width, job.height));
      canvas.width = job.width;
      canvas.height = job.height;
      const ctx = canvas.getContext("2d") as Scratch2D | null;
      if (!ctx) throw new Error("Canvas 2D is unavailable");
      ctx.drawImage(image, 0, 0, job.width, job.height);
      return await createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private failImageWorker() {
    this.imageWorker?.terminate();
    this.imageWorker = null;
    this.imageWorkerFailed = true;
    for (const job of this.activeImageJobs.values()) this.resizeImageFallback(job);
  }

  private pumpImageJobs() {
    if (this.destroyed) return;
    for (const [family] of this.imageJobs) {
      if (family.wantedFrame !== this.passFrame) this.discardImageJob(family);
    }
    for (const [family, region] of this.imageReservations) {
      if (!region.valid || family.wantedFrame !== this.passFrame) this.discardImageJob(family);
    }
    // Bound both work in flight and completed rasters waiting for atlas upload.
    let slots = 2 - this.activeImageJobs.size;
    for (const job of this.imageJobs.values()) if (job.bitmap) slots--;
    if (slots <= 0) return;
    for (const job of this.imageJobs.values()) {
      if (job.running || job.bitmap) continue;
      if (job.family.want !== job.bucket || job.family.users.size === 0) {
        this.discardImageJob(job.family);
        this.queueImageFamily(job.family);
        continue;
      }
      job.running = true;
      this.activeImageJobs.set(job.id, job);
      if (
        !this.imageWorkerFailed &&
        typeof Worker === "function" &&
        typeof OffscreenCanvas === "function"
      ) {
        try {
          if (!this.imageWorker) {
            const worker = new Worker(new URL("./imageRaster.worker.ts", import.meta.url), {
              type: "module",
            });
            worker.addEventListener("message", (event: MessageEvent<ImageRasterResponse>) => {
              const response = event.data;
              const active = this.activeImageJobs.get(response.id);
              if (!active) {
                if ("bitmap" in response) response.bitmap.close();
                return;
              }
              if ("bitmap" in response) this.finishImageJob(active, response.bitmap, true);
              else this.resizeImageFallback(active);
            });
            const onError = () => {
              if (this.imageWorker === worker) this.failImageWorker();
            };
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onError);
            this.imageWorker = worker;
          }
          this.imageWorker.postMessage(
            {
              id: job.id,
              bitmap: job.source.svg ? null : job.source.bitmap,
              svg: job.source.svg,
              width: job.width,
              height: job.height,
            } satisfies ImageRasterRequest,
            [],
          );
        } catch {
          this.failImageWorker();
        }
      } else {
        this.resizeImageFallback(job);
      }
      if (--slots <= 0) break;
    }
  }

  private rasterImage(family: TexFamily, bucket: number): TexEntry | null {
    const decoded = this.images.get(family.assetId!);
    if (decoded?.failed) return null;
    if (!family.rect) this.placeImage(family);
    const natural = this.naturalSize(family.assetId!);
    if (!family.rect || !natural) {
      this.decode(family.assetId!);
      return null;
    }
    const rect = family.rect;
    const vector = decoded?.svg || this.assets[family.assetId!]?.mimeType?.includes("svg");
    const scale = bucketScale(bucket);
    let pixelW = Math.min(vector ? Infinity : natural[0], Math.ceil(rect[2] * scale));
    let pixelH = Math.min(vector ? Infinity : natural[1], Math.ceil(rect[3] * scale));
    const fit = Math.min(1, MAX_RASTER / Math.max(pixelW, pixelH));
    pixelW = Math.max(1, Math.floor(pixelW * fit));
    pixelH = Math.max(1, Math.floor(pixelH * fit));
    const job = this.imageJobs.get(family);
    if (!job?.bitmap) {
      if (!job) {
        let region = this.imageReservations.get(family);
        if (region && (!region.valid || region.w !== pixelW + 2 || region.h !== pixelH + 2)) {
          this.releaseReservation(region);
          this.imageReservations.delete(family);
          region = undefined;
        }
        // Reserve from metadata before fetch/decode or resizing, so prefetch
        // cannot consume the visible image's space while pixels are pending.
        region ??= this.atlas.allocate(pixelW + 2, pixelH + 2, this.passFrame) ?? undefined;
        if (!region) {
          this.capacityFailures.set(family, { bucket, frame: this.passFrame });
          this.decode(family.assetId!);
          return null;
        }
        this.capacityFailures.delete(family);
        if (!decoded?.bitmap) {
          this.imageReservations.set(family, region);
          this.decode(family.assetId!);
          return null;
        }
        this.imageReservations.delete(family);
        this.imageJobs.set(family, {
          id: ++this.imageJobId,
          family,
          source: decoded,
          bucket,
          width: pixelW,
          height: pixelH,
          region,
          bitmap: null,
          running: false,
          fallback: false,
          gutter: false,
        });
        this.pumpImageJobs();
      }
      return null;
    }
    if (job.bucket !== bucket || job.source !== decoded) {
      this.discardImageJob(family);
      this.queueImageFamily(family);
      this.pumpImageJobs();
      return null;
    }
    this.imageJobs.delete(family);
    this.prepare(pixelW, pixelH);
    const ctx = this.ctx;
    if (job.gutter) {
      ctx.drawImage(job.bitmap, 0, 0);
    } else {
      ctx.drawImage(job.bitmap, 1, 1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(job.bitmap, 0, 0, pixelW, 1, 1, 0, pixelW, 1);
      ctx.drawImage(job.bitmap, 0, pixelH - 1, pixelW, 1, 1, pixelH + 1, pixelW, 1);
      ctx.drawImage(this.scratch, 1, 0, 1, pixelH + 2, 0, 0, 1, pixelH + 2);
      ctx.drawImage(this.scratch, pixelW, 0, 1, pixelH + 2, pixelW + 1, 0, 1, pixelH + 2);
      ctx.imageSmoothingEnabled = true;
    }
    job.bitmap.close();
    this.pumpImageJobs();
    return this.commit(family, bucket, pixelW, pixelH, job.region);
  }

  /** Gradient ramp (256 texels) for `stops`, allocated on first use. */
  ramp(stops: ReadonlyArray<CanvasGradientStop>, user: number): Ramp | null {
    let ramp = this.rampByStops.get(stops);
    if (!ramp || !ramp.region.valid) {
      const key = stops.map((stop) => `${stop.offset}:${stop.color}`).join(",");
      ramp = this.ramps.get(key);
      if (!ramp || !ramp.region.valid) {
        ramp = this.buildRamp(key, stops) ?? undefined;
        if (!ramp) return null;
      }
      this.rampByStops.set(stops, ramp);
    }
    ramp.users.add(user);
    return ramp;
  }

  /** Keeps ramp pages from being evicted while gradients are on screen. */
  touchRamps() {
    for (const ramp of this.ramps.values()) this.atlas.touch(ramp.region, this.passFrame);
  }

  private buildRamp(key: string, stops: ReadonlyArray<CanvasGradientStop>) {
    const region = this.atlas.allocate(256, 1, this.passFrame);
    if (!region) return null;
    const sorted = stops.toSorted((a, b) => a.offset - b.offset);
    const colors = sorted.map((stop) => parseColor(stop.color));
    const bytes = this.rampBytes;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let color = colors[0] ?? 0;
      if (sorted.length > 1 && t > sorted[0]!.offset) {
        color = colors[colors.length - 1]!;
        for (let k = 0; k < sorted.length - 1; k++) {
          const a = sorted[k]!;
          const b = sorted[k + 1]!;
          if (t <= b.offset) {
            const span = b.offset - a.offset;
            color = mixColor(colors[k]!, colors[k + 1]!, span > 0 ? (t - a.offset) / span : 1);
            break;
          }
        }
      }
      const premul = premultiply(color, 1);
      bytes[i * 4] = premul & 255;
      bytes[i * 4 + 1] = (premul >>> 8) & 255;
      bytes[i * 4 + 2] = (premul >>> 16) & 255;
      bytes[i * 4 + 3] = premul >>> 24;
    }
    this.atlas.uploadBytes(region, bytes);
    const size = this.atlas.size;
    const ramp: Ramp = {
      region,
      u0: (region.x + 0.5) / size,
      u1: (region.x + 255.5) / size,
      v: (region.y + 0.5) / size,
      users: new Set(),
    };
    region.onEvict = () => {
      if (this.ramps.get(key) === ramp) this.ramps.delete(key);
      this.onRampEvicted(ramp);
    };
    this.ramps.set(key, ramp);
    return ramp;
  }

  destroy() {
    this.destroyed = true;
    this.clearImageJobs();
    this.clearShaderJobs();
    this.shaders.clear();
    this.capacityFailures.clear();
    for (const decoded of this.images.values()) decoded.bitmap?.close();
    this.images.clear();
    this.families.clear();
    this.queue.length = 0;
    this.queueHead = 0;
    this.upload = null;
    this.table.destroy();
  }
}

function maxBucketFor(w: number, h: number) {
  // Cap before clamping the bucket index so small icons retain the 16x bucket.
  // Large paths stay within a whole bucket instead of monopolizing an atlas page.
  const exponent = Math.floor(Math.log2(MAX_RASTER / Math.max(w, h, 1)));
  return Math.min(BUCKET_COUNT - 1, Math.max(0, exponent + BUCKET_BIAS));
}

function setLetterSpacing(ctx: Scratch2D, spacing: number) {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
}

function drawJustified(ctx: Scratch2D, content: string, width: number, y: number) {
  const words = content.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < 2) {
    ctx.fillText(content, 0, y);
    return;
  }
  let total = 0;
  for (const word of words) total += ctx.measureText(word).width;
  const gap = (width - total) / (words.length - 1);
  let x = 0;
  for (const word of words) {
    ctx.fillText(word, x, y);
    x += ctx.measureText(word).width + gap;
  }
}

function cssColor(color: number) {
  return `rgba(${color & 255},${(color >>> 8) & 255},${(color >>> 16) & 255},${(color >>> 24) / 255})`;
}

function canvasPaint(ctx: Scratch2D, paint: CanvasPaint, w: number, h: number) {
  if (paint.type === "solid") return cssColor(parseColor(paint.color));
  if (paint.type === "image" || paint.type === "shader") return null;
  let gradient: CanvasGradient;
  if (paint.type === "linear-gradient") {
    const [x0, y0, x1, y1] = linearGradientLine(paint.angle, w, h);
    gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  } else {
    const cx = w * (paint.center?.x ?? 0.5);
    const cy = h * (paint.center?.y ?? 0.5);
    if (paint.size) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(
        Math.max((w * paint.size.width) / 2, 0.000001),
        Math.max((h * paint.size.height) / 2, 0.000001),
      );
      gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      ctx.restore();
    } else {
      const r = Math.hypot(w, h) / 2;
      gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    }
  }
  for (const stop of paint.stops) {
    gradient.addColorStop(Math.min(1, Math.max(0, stop.offset)), cssColor(parseColor(stop.color)));
  }
  return gradient;
}

/** CSS linear-gradient line for `angle` degrees over a w x h box: [x0, y0, x1, y1]. */
export function linearGradientLine(angle: number, w: number, h: number) {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half] as const;
}

function paintKey(fills: ReadonlyArray<CanvasPaint> | undefined) {
  if (!fills) return "";
  return fills
    .map((fill) =>
      fill.type === "solid"
        ? fill.color
        : fill.type === "image"
          ? `img:${fill.assetId}`
          : fill.type === "shader" || fill.type === "radial-gradient"
            ? JSON.stringify(fill)
            : `${fill.type}:${fill.angle}:${fill.stops.map((s) => `${s.offset}/${s.color}`).join(",")}`,
    )
    .join(";");
}

function strokeKey(strokes: ReadonlyArray<CanvasStroke> | undefined) {
  if (!strokes) return "";
  return strokes
    .map((s) => `${s.color}/${s.width}/${s.align ?? "center"}/${s.dash?.join(" ") ?? ""}`)
    .join(";");
}
