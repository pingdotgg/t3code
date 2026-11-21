/**
 * Texture-array atlas shared by text, image, path rasters and gradient ramps.
 * Each layer is a page with shelf packing. When every page is full the
 * least-recently-used page is reset. Partly visible pages reclaim individual
 * stale regions instead, so a small icon cannot pin a page of old rasters.
 */

export interface AtlasRegion {
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
  valid: boolean;
  lastUsed: number;
  onEvict: (() => void) | null;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shelf {
  y: number;
  h: number;
  x: number;
}

interface Page {
  shelves: Shelf[];
  nextY: number;
  lastUsed: number;
  regions: AtlasRegion[];
  /** Null until pressure converts shelf packing to reusable rectangles. */
  free: FreeRect[] | null;
}

export class TextureAtlas {
  readonly size: number;
  texture: WebGLTexture | null = null;
  private layers = 0;
  private pages: Page[] = [];
  private readonly maxLayers: number;
  private readonly fbos: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  evictions = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    initialLayers: number,
    maxLayers: number,
  ) {
    this.size = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.maxLayers = Math.max(
      1,
      Math.min(maxLayers, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number),
    );
    this.allocateTexture(Math.min(initialLayers, this.maxLayers), false);
  }

  /** Recreates GPU state after a context restore. Every region is evicted. */
  restore(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.texture = null;
    this.fbos[0] = null;
    this.fbos[1] = null;
    for (const page of this.pages) this.resetPage(page);
    const layers = this.layers;
    this.layers = 0;
    this.pages = [];
    this.allocateTexture(layers, false);
  }

  private allocateTexture(layers: number, copy: boolean) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.size, this.size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (copy && this.texture) {
      const fbo = (this.fbos[0] ??= gl.createFramebuffer());
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      for (let layer = 0; layer < this.layers; layer++) {
        gl.framebufferTextureLayer(
          gl.READ_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          this.texture,
          0,
          layer,
        );
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, this.size, this.size);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteTexture(this.texture);
    }
    this.texture = texture;
    for (let layer = this.layers; layer < layers; layer++) {
      this.pages.push({ shelves: [], nextY: 0, lastUsed: -1, regions: [], free: null });
    }
    this.layers = layers;
  }

  private resetPage(page: Page) {
    for (const region of page.regions) {
      region.valid = false;
      const onEvict = region.onEvict;
      region.onEvict = null;
      onEvict?.();
    }
    page.regions = [];
    page.shelves = [];
    page.nextY = 0;
    page.free = null;
    this.evictions++;
  }

  /** Subtracts occupied space from every free rectangle, including overlaps. */
  private subtract(free: FreeRect[], used: FreeRect) {
    const splits: FreeRect[] = [];
    for (let i = free.length - 1; i >= 0; i--) {
      const rect = free[i]!;
      const right = rect.x + rect.w;
      const bottom = rect.y + rect.h;
      const usedRight = used.x + used.w;
      const usedBottom = used.y + used.h;
      if (used.x >= right || usedRight <= rect.x || used.y >= bottom || usedBottom <= rect.y)
        continue;
      free[i] = free[free.length - 1]!;
      free.pop();
      if (used.x > rect.x) splits.push({ ...rect, w: used.x - rect.x });
      if (usedRight < right) splits.push({ ...rect, x: usedRight, w: right - usedRight });
      if (used.y > rect.y) splits.push({ ...rect, h: used.y - rect.y });
      if (usedBottom < bottom) splits.push({ ...rect, y: usedBottom, h: bottom - usedBottom });
    }
    // Existing rectangles are already pruned; only new splits need comparison.
    for (const rect of splits) {
      let contained = false;
      for (let i = free.length - 1; i >= 0; i--) {
        const other = free[i]!;
        if (
          rect.x >= other.x &&
          rect.y >= other.y &&
          rect.x + rect.w <= other.x + other.w &&
          rect.y + rect.h <= other.y + other.h
        ) {
          contained = true;
          break;
        }
        if (
          other.x >= rect.x &&
          other.y >= rect.y &&
          other.x + other.w <= rect.x + rect.w &&
          other.y + other.h <= rect.y + rect.h
        ) {
          free[i] = free[free.length - 1]!;
          free.pop();
        }
      }
      if (!contained) free.push(rect);
    }
  }

  private reclaim(page: Page, frame: number) {
    const stale = page.regions.filter((region) => region.lastUsed < frame);
    if (stale.length === 0) return false;
    page.regions = page.regions.filter((region) => region.lastUsed >= frame);
    page.shelves = [];
    page.free = [{ x: 0, y: 0, w: this.size, h: this.size }];
    for (const region of page.regions) this.subtract(page.free, region);
    // All stale entries become invalid before callbacks choose a fallback.
    for (const region of stale) region.valid = false;
    for (const region of stale) {
      const onEvict = region.onEvict;
      region.onEvict = null;
      onEvict?.();
    }
    this.evictions++;
    return true;
  }

  private tryPage(
    page: Page,
    layer: number,
    w: number,
    h: number,
    frame: number,
    allowTallShelves = false,
  ): AtlasRegion | null {
    const size = this.size;
    if (page.free) {
      let best: FreeRect | undefined;
      for (const rect of page.free) {
        if (rect.w >= w && rect.h >= h && (!best || rect.w * rect.h < best.w * best.h)) best = rect;
      }
      if (!best) return null;
      const region = {
        layer,
        x: best.x,
        y: best.y,
        w,
        h,
        valid: true,
        lastUsed: frame,
        onEvict: null,
      };
      this.subtract(page.free, region);
      page.regions.push(region);
      return region;
    }
    for (const shelf of page.shelves) {
      if (shelf.h >= h && (allowTallShelves || shelf.h <= h * 1.5 + 8) && size - shelf.x >= w) {
        const region = {
          layer,
          x: shelf.x,
          y: shelf.y,
          w,
          h,
          valid: true,
          lastUsed: frame,
          onEvict: null,
        };
        shelf.x += w;
        page.regions.push(region);
        return region;
      }
    }
    const shelfH = Math.min(size, (h + 3) & ~3);
    if (page.nextY + shelfH > size) return null;
    const shelf = { y: page.nextY, h: shelfH, x: w };
    page.nextY += shelfH;
    page.shelves.push(shelf);
    const region = { layer, x: 0, y: shelf.y, w, h, valid: true, lastUsed: frame, onEvict: null };
    page.regions.push(region);
    return region;
  }

  /** Reserves `w`x`h` texels. Returns null when nothing can be evicted this frame. */
  allocate(w: number, h: number, frame: number): AtlasRegion | null {
    if (w > this.size || h > this.size) return null;
    for (let layer = 0; layer < this.pages.length; layer++) {
      const region = this.tryPage(this.pages[layer]!, layer, w, h, frame);
      if (region) {
        this.pages[layer]!.lastUsed = frame;
        return region;
      }
    }
    // Reuse space beside tall paths before growing or evicting. A small icon
    // still fits there even when the preferred shelf-height ratio rejects it.
    for (let layer = 0; layer < this.pages.length; layer++) {
      const region = this.tryPage(this.pages[layer]!, layer, w, h, frame, true);
      if (region) {
        this.pages[layer]!.lastUsed = frame;
        return region;
      }
    }
    if (this.layers < this.maxLayers) {
      const first = this.layers;
      this.allocateTexture(Math.min(this.maxLayers, this.layers * 2), true);
      const region = this.tryPage(this.pages[first]!, first, w, h, frame);
      if (region) this.pages[first]!.lastUsed = frame;
      return region;
    }
    let victim = -1;
    for (let layer = 0; layer < this.pages.length; layer++) {
      const page = this.pages[layer]!;
      if (page.lastUsed >= frame) continue;
      if (victim < 0 || page.lastUsed < this.pages[victim]!.lastUsed) victim = layer;
    }
    if (victim < 0) {
      for (let layer = 0; layer < this.pages.length; layer++) {
        const page = this.pages[layer]!;
        if (!this.reclaim(page, frame)) continue;
        const region = this.tryPage(page, layer, w, h, frame);
        if (region) return region;
      }
      return null;
    }
    const page = this.pages[victim]!;
    this.resetPage(page);
    const region = this.tryPage(page, victim, w, h, frame);
    if (region) page.lastUsed = frame;
    return region;
  }

  touch(region: AtlasRegion, frame: number) {
    if (region.lastUsed < frame) region.lastUsed = frame;
    const page = this.pages[region.layer];
    if (page && page.lastUsed < frame) page.lastUsed = frame;
  }

  /** Uploads premultiplied RGBA bytes covering the whole region. */
  uploadBytes(region: AtlasRegion, bytes: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      region.x,
      region.y,
      region.layer,
      region.w,
      region.h,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  /**
   * Uploads rows [`fromRow`, `fromRow + rows`) of a canvas's top-left
   * `region.w` columns into the same rows of the region. The canvas stays
   * premultiplied, so no per-pixel work happens in JS.
   */
  uploadCanvasRows(
    region: AtlasRegion,
    source: OffscreenCanvas | HTMLCanvasElement,
    fromRow: number,
    rows: number,
  ) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, fromRow);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      region.x,
      region.y + fromRow,
      region.layer,
      region.w,
      rows,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  destroy() {
    this.gl.deleteTexture(this.texture);
    for (const fbo of this.fbos) if (fbo) this.gl.deleteFramebuffer(fbo);
    this.texture = null;
  }
}
