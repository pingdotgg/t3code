import type { ThemeBackdrop } from "@t3tools/shared/themePalettes";

const BACKDROP_DATA_ATTRIBUTE = "themeBackdrop";
const BACKDROP_OPACITY_VARIABLE = "--theme-backdrop-surface-opacity";
const DEFAULT_FPS = 30;
const DEFAULT_SURFACE_OPACITY = 0.35;
const DEFAULT_HDR_PEAK = 3;
const DEFAULT_CELL_SIZE: readonly [number, number] = [4, 6];
const DEFAULT_GLYPH_SCALE = 1;
const DAYLIGHT_REFRESH_MS = 60_000;

let activeBackdrop: ThemeBackdrop | null = null;
const listeners = new Set<() => void>();

function glyphsEqual(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function backdropEqual(a: ThemeBackdrop | null, b: ThemeBackdrop | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.glsl === b.glsl &&
    a.wgsl === b.wgsl &&
    a.hdr === b.hdr &&
    a.hdrPeak === b.hdrPeak &&
    a.cellSize?.[0] === b.cellSize?.[0] &&
    a.cellSize?.[1] === b.cellSize?.[1] &&
    a.glyphScale === b.glyphScale &&
    glyphsEqual(a.glyphs, b.glyphs) &&
    a.fps === b.fps &&
    a.opacity === b.opacity
  );
}

function resolveBackdrop(backdrop: ThemeBackdrop | undefined): ThemeBackdrop | null {
  if (backdrop === undefined) return null;
  const hasGlsl = typeof backdrop.glsl === "string" && backdrop.glsl.trim().length > 0;
  const hasWgsl = typeof backdrop.wgsl === "string" && backdrop.wgsl.trim().length > 0;
  if (!hasGlsl && !hasWgsl) return null;
  return backdrop;
}

export function getActiveThemeBackdrop(): ThemeBackdrop | null {
  return activeBackdrop;
}

export function subscribeThemeBackdrop(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyThemeBackdrop(backdrop: ThemeBackdrop | undefined): void {
  const next = resolveBackdrop(backdrop);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (next === null) {
      delete root.dataset[BACKDROP_DATA_ATTRIBUTE];
      root.style.removeProperty(BACKDROP_OPACITY_VARIABLE);
    } else {
      root.dataset[BACKDROP_DATA_ATTRIBUTE] = "active";
      const opacity = Math.min(1, Math.max(0, next.opacity ?? DEFAULT_SURFACE_OPACITY));
      root.style.setProperty(BACKDROP_OPACITY_VARIABLE, String(opacity));
    }
  }
  if (backdropEqual(activeBackdrop, next)) return;
  activeBackdrop = next;
  for (const listener of listeners) listener();
}

/** Smooth 0..1 daylight curve from local wall-clock time (0 = midnight, 1 = midday). */
export function computeDaylight(ms: number = Date.now()): number {
  const now = new Date(ms);
  const hour = now.getHours() + now.getMinutes() / 60;
  const sun = Math.sin((2 * Math.PI * (hour - 6)) / 24);
  const t = Math.min(Math.max((sun + 0.7) / 1.4, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Packs a `|`-separated bitmap glyph string (`.` / `#`) into a 32-bit bitmask. */
export function packGlyphBits(glyph: string): number {
  let bits = 0;
  let index = 0;
  for (const ch of glyph) {
    if (ch === "|") continue;
    if (ch === "#") bits |= 1 << index;
    index += 1;
  }
  return bits >>> 0;
}

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Theme backdrop shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function mountWebGlBackdropCanvas(canvas: HTMLCanvasElement, backdrop: ThemeBackdrop): () => void {
  const fragmentSource = backdrop.glsl?.trim() ?? "";
  if (fragmentSource.length === 0) return () => {};

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  if (!gl) return () => {};

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return () => {};
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return () => {};
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Theme backdrop shader link error:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return () => {};
  }

  const uTime = gl.getUniformLocation(program, "u_time");
  const uResolution = gl.getUniformLocation(program, "u_resolution");
  const uDaylight = gl.getUniformLocation(program, "u_daylight");
  const uDark = gl.getUniformLocation(program, "u_dark");

  const vao = gl.createVertexArray();
  const fps = Math.min(60, Math.max(1, backdrop.fps ?? DEFAULT_FPS));
  const frameIntervalMs = 1000 / fps;
  let daylight = computeDaylight();
  const daylightTimer = window.setInterval(() => {
    daylight = computeDaylight();
  }, DAYLIGHT_REFRESH_MS);

  const syncSize = () => {
    const width = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  };
  syncSize();
  window.addEventListener("resize", syncSize);

  let disposed = false;
  let rafId = 0;
  let lastFrameMs = 0;
  const startMs = performance.now();

  const draw = (nowMs: number) => {
    if (disposed) return;
    rafId = window.requestAnimationFrame(draw);
    if (document.hidden) return;
    if (lastFrameMs !== 0 && nowMs - lastFrameMs < frameIntervalMs) return;
    lastFrameMs = nowMs;

    syncSize();
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    if (uTime) gl.uniform1f(uTime, (nowMs - startMs) / 1000);
    if (uResolution) gl.uniform2f(uResolution, canvas.width, canvas.height);
    if (uDaylight) gl.uniform1f(uDaylight, daylight);
    if (uDark) gl.uniform1f(uDark, document.documentElement.classList.contains("dark") ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const onVisibilityChange = () => {
    if (!document.hidden) lastFrameMs = 0;
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  rafId = window.requestAnimationFrame(draw);

  return () => {
    disposed = true;
    window.cancelAnimationFrame(rafId);
    window.clearInterval(daylightTimer);
    window.removeEventListener("resize", syncSize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  };
}

interface WebGpuTextureViewLike {}
interface WebGpuTextureLike {
  createView(): WebGpuTextureViewLike;
  destroy(): void;
}
interface WebGpuBufferLike {
  destroy(): void;
}
interface WebGpuBindGroupLike {}
interface WebGpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}
interface WebGpuRenderPassEncoderLike {
  setPipeline(pipeline: WebGpuRenderPipelineLike): void;
  setBindGroup(index: number, bindGroup: WebGpuBindGroupLike): void;
  draw(vertexCount: number): void;
  end(): void;
}
interface WebGpuCommandEncoderLike {
  beginRenderPass(descriptor: {
    colorAttachments: ReadonlyArray<{
      view: WebGpuTextureViewLike;
      loadOp: "clear";
      storeOp: "store";
      clearValue: { r: number; g: number; b: number; a: number };
    }>;
  }): WebGpuRenderPassEncoderLike;
  finish(): unknown;
}
interface WebGpuDeviceLike {
  createShaderModule(descriptor: { code: string }): unknown;
  createRenderPipeline(descriptor: unknown): WebGpuRenderPipelineLike;
  createSampler(descriptor: { magFilter: "linear"; minFilter: "linear" }): unknown;
  createBuffer(descriptor: { size: number; usage: number }): WebGpuBufferLike;
  createTexture(descriptor: {
    size: readonly [number, number];
    format: string;
    usage: number;
  }): WebGpuTextureLike;
  createBindGroup(descriptor: {
    layout: unknown;
    entries: ReadonlyArray<{ binding: number; resource: unknown }>;
  }): WebGpuBindGroupLike;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  queue: {
    writeBuffer(
      buffer: WebGpuBufferLike,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
    ): void;
    submit(commandBuffers: ReadonlyArray<unknown>): void;
  };
  destroy(): void;
}
interface WebGpuCanvasContextLike {
  configure(config: {
    device: WebGpuDeviceLike;
    format: string;
    alphaMode: "opaque";
    toneMapping?: { mode: "extended" | "standard" };
  }): void;
  getCurrentTexture(): WebGpuTextureLike;
}
interface WebGpuNavigatorLike {
  gpu?: {
    requestAdapter(): Promise<{ requestDevice(): Promise<WebGpuDeviceLike> } | null>;
    getPreferredCanvasFormat(): string;
  };
}

const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;

function isMultiPassBloomWgsl(source: string): boolean {
  return (
    /@fragment\s+fn\s+field\b/.test(source) &&
    /@fragment\s+fn\s+blur\b/.test(source) &&
    /@fragment\s+fn\s+composite\b/.test(source)
  );
}

function mountWebGpuBackdropCanvas(canvas: HTMLCanvasElement, backdrop: ThemeBackdrop): () => void {
  const wgslSource = backdrop.wgsl?.trim() ?? "";
  const gpu = (navigator as unknown as WebGpuNavigatorLike).gpu;
  if (wgslSource.length === 0 || !gpu) return () => {};

  let disposed = false;
  let rafId = 0;
  let daylightTimer = 0;
  let cleanupResources: (() => void) | null = null;

  const init = async () => {
    const adapter = await gpu.requestAdapter();
    if (!adapter || disposed) return;
    const device = await adapter.requestDevice();
    if (disposed) {
      device.destroy();
      return;
    }
    const ctx = canvas.getContext("webgpu") as WebGpuCanvasContextLike | null;
    if (!ctx) {
      device.destroy();
      return;
    }

    const displayHdr =
      backdrop.hdr !== false &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(dynamic-range: high)").matches;
    const canvasFormat = displayHdr ? "rgba16float" : gpu.getPreferredCanvasFormat();
    ctx.configure({
      device,
      format: canvasFormat,
      alphaMode: "opaque",
      toneMapping: { mode: displayHdr ? "extended" : "standard" },
    });

    const shaderModule = device.createShaderModule({ code: wgslSource });
    const f16 = "rgba16float";
    const makePipe = (entryPoint: string, targets: ReadonlyArray<string>) =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shaderModule, entryPoint: "vs" },
        fragment: {
          module: shaderModule,
          entryPoint,
          targets: targets.map((format) => ({ format })),
        },
      });

    const multiPass = isMultiPassBloomWgsl(wgslSource);
    const fps = Math.min(60, Math.max(1, backdrop.fps ?? DEFAULT_FPS));
    const frameIntervalMs = 1000 / fps;
    const hdrPeak = backdrop.hdrPeak ?? DEFAULT_HDR_PEAK;
    const [cellW, cellH] = backdrop.cellSize ?? DEFAULT_CELL_SIZE;
    const glyphScale = backdrop.glyphScale ?? DEFAULT_GLYPH_SCALE;

    const ubuf = device.createBuffer({
      size: 80,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    const udata = new ArrayBuffer(80);
    const uf = new Float32Array(udata);
    if (backdrop.glyphs && backdrop.glyphs.length > 0) {
      const packed = backdrop.glyphs.slice(0, 12).map(packGlyphBits);
      new Uint32Array(udata, 32, 12).set(packed);
    }

    let daylight = computeDaylight();
    daylightTimer = window.setInterval(() => {
      daylight = computeDaylight();
    }, DAYLIGHT_REFRESH_MS);

    const runPass = (
      enc: WebGpuCommandEncoderLike,
      pipeline: WebGpuRenderPipelineLike,
      group: WebGpuBindGroupLike,
      views: ReadonlyArray<WebGpuTextureViewLike>,
    ) => {
      const pass = enc.beginRenderPass({
        colorAttachments: views.map((view) => ({
          view,
          loadOp: "clear" as const,
          storeOp: "store" as const,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };

    const ownedTextures: WebGpuTextureLike[] = [];
    const ownedBuffers: WebGpuBufferLike[] = [];
    const releasePassResources = () => {
      for (const tex of ownedTextures) tex.destroy();
      ownedTextures.length = 0;
      for (const buf of ownedBuffers) buf.destroy();
      ownedBuffers.length = 0;
    };

    let renderFrame: () => void = () => {};

    if (multiPass) {
      const fieldPipe = makePipe("field", [f16, f16]);
      const blurPipe = makePipe("blur", [f16]);
      const compPipe = makePipe("composite", [canvasFormat]);
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

      const makeTex = (w: number, h: number) => {
        const tex = device.createTexture({
          size: [Math.max(1, w), Math.max(1, h)],
          format: f16,
          usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        });
        ownedTextures.push(tex);
        return tex;
      };

      const buildPasses = () => {
        releasePassResources();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round((canvas.clientWidth || window.innerWidth) * dpr));
        const height = Math.max(1, Math.round((canvas.clientHeight || window.innerHeight) * dpr));
        canvas.width = width;
        canvas.height = height;
        const cols = Math.ceil(width / (cellW * glyphScale));
        const rows = Math.ceil(height / (cellH * glyphScale));
        uf.set([width, height, cols, rows], 0);
        uf[5] = displayHdr ? 1 : 0;
        uf[6] = hdrPeak;
        uf[7] = glyphScale;

        const cells = makeTex(cols, rows);
        const glow = makeTex(cols, rows);
        const blurStep = (
          from: WebGpuTextureLike,
          w: number,
          h: number,
          dx: number,
          dy: number,
        ) => {
          const out = makeTex(w, h);
          const buf = device.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
          });
          ownedBuffers.push(buf);
          device.queue.writeBuffer(buf, 0, new Float32Array([dx / w, dy / h, w, h]));
          const group = device.createBindGroup({
            layout: blurPipe.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: buf } },
              { binding: 1, resource: from.createView() },
              { binding: 2, resource: sampler },
            ],
          });
          return { out, group };
        };
        const hw = Math.max(1, Math.ceil(cols / 2));
        const hh = Math.max(1, Math.ceil(rows / 2));
        const qw = Math.max(1, Math.ceil(cols / 4));
        const qh = Math.max(1, Math.ceil(rows / 4));
        const nearH = blurStep(glow, hw, hh, 1, 0);
        const nearV = blurStep(nearH.out, hw, hh, 0, 1);
        const wideH = blurStep(nearV.out, qw, qh, 1.6, 0);
        const wideV = blurStep(wideH.out, qw, qh, 0, 1.6);
        const blurs = [nearH, nearV, wideH, wideV];

        const fieldGroup = device.createBindGroup({
          layout: fieldPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: ubuf } }],
        });
        const compGroup = device.createBindGroup({
          layout: compPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: cells.createView() },
            { binding: 2, resource: nearV.out.createView() },
            { binding: 3, resource: wideV.out.createView() },
            { binding: 4, resource: sampler },
          ],
        });

        renderFrame = () => {
          const enc = device.createCommandEncoder();
          runPass(enc, fieldPipe, fieldGroup, [cells.createView(), glow.createView()]);
          for (const b of blurs) runPass(enc, blurPipe, b.group, [b.out.createView()]);
          runPass(enc, compPipe, compGroup, [ctx.getCurrentTexture().createView()]);
          device.queue.submit([enc.finish()]);
        };
      };

      buildPasses();
      window.addEventListener("resize", buildPasses);
      cleanupResources = () => {
        window.removeEventListener("resize", buildPasses);
        releasePassResources();
        ubuf.destroy();
        device.destroy();
      };
    } else {
      const fsPipe = makePipe("fs", [canvasFormat]);
      const fsGroup = device.createBindGroup({
        layout: fsPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ubuf } }],
      });
      const syncSize = () => {
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round((canvas.clientWidth || window.innerWidth) * dpr));
        const height = Math.max(1, Math.round((canvas.clientHeight || window.innerHeight) * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        uf[0] = width;
        uf[1] = height;
        uf[3] = daylight;
        uf[4] = document.documentElement.classList.contains("dark") ? 1 : 0;
        uf[5] = displayHdr ? 1 : 0;
        uf[6] = hdrPeak;
      };
      syncSize();
      window.addEventListener("resize", syncSize);
      renderFrame = () => {
        syncSize();
        const enc = device.createCommandEncoder();
        runPass(enc, fsPipe, fsGroup, [ctx.getCurrentTexture().createView()]);
        device.queue.submit([enc.finish()]);
      };
      cleanupResources = () => {
        window.removeEventListener("resize", syncSize);
        ubuf.destroy();
        device.destroy();
      };
    }

    const startMs = performance.now();
    let lastFrameMs = 0;
    const draw = (nowMs: number) => {
      if (disposed) return;
      rafId = window.requestAnimationFrame(draw);
      if (document.hidden) return;
      if (lastFrameMs !== 0 && nowMs - lastFrameMs < frameIntervalMs) return;
      lastFrameMs = nowMs;

      if (multiPass) {
        uf[4] = (nowMs - startMs) / 1000;
      } else {
        uf[2] = (nowMs - startMs) / 1000;
      }
      device.queue.writeBuffer(ubuf, 0, udata);
      renderFrame();
    };

    const onVisibilityChange = () => {
      if (!document.hidden) lastFrameMs = 0;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const prevCleanup = cleanupResources;
    cleanupResources = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      prevCleanup?.();
    };
    rafId = window.requestAnimationFrame(draw);
  };

  void init().catch((error: unknown) => {
    console.warn("Theme WebGPU backdrop init failed:", error);
  });

  return () => {
    disposed = true;
    window.cancelAnimationFrame(rafId);
    window.clearInterval(daylightTimer);
    cleanupResources?.();
    cleanupResources = null;
  };
}

export function mountThemeBackdropCanvas(
  canvas: HTMLCanvasElement,
  backdrop: ThemeBackdrop,
): () => void {
  if (backdrop.wgsl && backdrop.wgsl.trim().length > 0) {
    return mountWebGpuBackdropCanvas(canvas, backdrop);
  }
  return mountWebGlBackdropCanvas(canvas, backdrop);
}
