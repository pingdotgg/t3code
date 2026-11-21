import { FLAG_ELLIPSE, STRIDE, STRIDE_BYTES, W_COLOR, W_EFFECT_ALPHA, W_FLAGS } from "./format";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

/** Attribute layout: [location, components, word offset, kind]. */
const ATTRIBUTES: ReadonlyArray<readonly [number, number, number, "f" | "u8" | "u32"]> = [
  [0, 4, 0, "f"],
  [1, 2, 4, "f"],
  [2, 4, 6, "f"],
  [3, 4, 10, "f"],
  [4, 4, 14, "f"],
  [5, 3, 18, "f"],
  [6, 4, 21, "f"],
  [7, 4, 25, "f"],
  [8, 4, 29, "u8"],
  [9, 1, 30, "u32"],
  [10, 1, W_EFFECT_ALPHA, "f"],
];

export interface ViewUniforms {
  /** Device px per world unit. */
  scale: number;
  tx: number;
  ty: number;
  width: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  flipY: number;
}

interface SpecializedProgram {
  program: WebGLProgram;
  view: WebGLUniformLocation | null;
  viewport: WebGLUniformLocation | null;
  worldView: WebGLUniformLocation | null;
  flipY: WebGLUniformLocation | null;
  compositeLayer: WebGLUniformLocation | null;
  frame: number;
  composite: boolean;
}

/** Dense overviews stay instanced instead of paying thousands of program switches. */
const MAX_SPECIALIZED_RUNS = 512;

/** Owns instanced shaders and buffers. Software GPUs specialize simple primitives. */
export class Renderer {
  private program!: WebGLProgram;
  private sceneVao!: WebGLVertexArrayObject;
  private sceneBuffer!: WebGLBuffer;
  private overlayVao!: WebGLVertexArrayObject;
  private overlayBuffer!: WebGLBuffer;
  private bufferCapacity = 0;
  private overlayCapacity = 0;
  private uView!: WebGLUniformLocation | null;
  private uViewport!: WebGLUniformLocation | null;
  private uWorldView!: WebGLUniformLocation | null;
  private uFlipY!: WebGLUniformLocation | null;
  private uCompositeLayer!: WebGLUniformLocation | null;
  private boundBase = -1;
  private readonly specialized = new Map<number, SpecializedProgram>();
  private kinds = new Uint8Array(0);
  private boundKind = -1;
  private frame = 0;
  private view: ViewUniforms | null = null;
  private compositeLayer = false;
  drawCalls = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.init();
  }

  init() {
    const gl = this.gl;
    const compile = (type: number, source: string, program: WebGLProgram) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(`Canvas shader failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
      }
      gl.attachShader(program, shader);
      return shader;
    };
    const makeProgram = (kind?: number) => {
      const program = gl.createProgram();
      const specialize = (source: string) =>
        kind === undefined
          ? source
          : source.replace(
              "#version 300 es",
              `#version 300 es\n#define PRIMITIVE_KIND ${kind}u${kind < 4 ? "\n#define PRIMITIVE_ELLIPSE false" : ""}`,
            );
      const vs = compile(gl.VERTEX_SHADER, specialize(VERTEX_SHADER), program);
      const fs = compile(gl.FRAGMENT_SHADER, specialize(FRAGMENT_SHADER), program);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(`Canvas program failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), 0);
      gl.uniform1i(gl.getUniformLocation(program, "uTable"), 1);
      return program;
    };
    const program = makeProgram();
    this.program = program;
    gl.useProgram(program);
    this.uView = gl.getUniformLocation(program, "uView");
    this.uViewport = gl.getUniformLocation(program, "uViewport");
    this.uWorldView = gl.getUniformLocation(program, "uWorldView");
    this.uFlipY = gl.getUniformLocation(program, "uFlipY");
    this.uCompositeLayer = gl.getUniformLocation(program, "uCompositeLayer");
    gl.uniform1i(this.uCompositeLayer, 0);

    // Software GPUs pay heavily for the general fragment shader, even on
    // simple quads. Keep paint order, but compile out unused paths for them.
    this.specialized.clear();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const device = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|softpipe|software rasterizer/i.test(device)) {
      for (const kind of [0, 1, 2, 3, 4]) {
        const program = makeProgram(kind);
        this.specialized.set(kind, {
          program,
          view: gl.getUniformLocation(program, "uView"),
          viewport: gl.getUniformLocation(program, "uViewport"),
          worldView: gl.getUniformLocation(program, "uWorldView"),
          flipY: gl.getUniformLocation(program, "uFlipY"),
          compositeLayer: gl.getUniformLocation(program, "uCompositeLayer"),
          frame: -1,
          composite: false,
        });
      }
    }
    this.boundKind = -1;
    this.kinds = new Uint8Array(0);

    this.sceneBuffer = gl.createBuffer();
    this.sceneVao = gl.createVertexArray();
    this.overlayBuffer = gl.createBuffer();
    this.overlayVao = gl.createVertexArray();
    this.bufferCapacity = 0;
    this.overlayCapacity = 0;
    gl.bindVertexArray(this.overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
    this.pointAttributes(0, true);
    gl.bindVertexArray(this.sceneVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sceneBuffer);
    this.pointAttributes(0, true);
    this.boundBase = 0;
    gl.bindVertexArray(null);
  }

  private pointAttributes(base: number, enable: boolean) {
    const gl = this.gl;
    const offset = base * STRIDE_BYTES;
    for (const [location, size, word, kind] of ATTRIBUTES) {
      if (enable) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribDivisor(location, 1);
      }
      if (kind === "u32") {
        gl.vertexAttribIPointer(location, size, gl.UNSIGNED_INT, STRIDE_BYTES, offset + word * 4);
      } else if (kind === "u8") {
        gl.vertexAttribPointer(
          location,
          size,
          gl.UNSIGNED_BYTE,
          true,
          STRIDE_BYTES,
          offset + word * 4,
        );
      } else {
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE_BYTES, offset + word * 4);
      }
    }
  }

  /** Full upload of `count` instances, growing the buffer to at least `reserve`. */
  uploadAll(f32: Float32Array, count: number, reserve = count) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sceneBuffer);
    if (count > this.bufferCapacity || reserve > this.bufferCapacity) {
      this.bufferCapacity = Math.max(count, reserve, Math.ceil(this.bufferCapacity * 1.25), 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.bufferCapacity * STRIDE_BYTES, gl.DYNAMIC_DRAW);
    }
    if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32, 0, count * STRIDE);
    this.updateKinds(f32, 0, count);
  }

  /** Uploads instances [start, end). */
  uploadRange(f32: Float32Array, start: number, end: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sceneBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      start * STRIDE_BYTES,
      f32,
      start * STRIDE,
      (end - start) * STRIDE,
    );
    this.updateKinds(f32, start, end);
  }

  private updateKinds(f32: Float32Array, start: number, end: number) {
    if (this.specialized.size === 0) return;
    if (this.kinds.length < this.bufferCapacity) {
      const next = new Uint8Array(this.bufferCapacity);
      next.set(this.kinds);
      this.kinds = next;
    }
    const words = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
    for (let i = start; i < end; i++) {
      const flags = words[i * STRIDE + W_FLAGS]!;
      const kind = Math.min(4, flags & 15);
      this.kinds[i] =
        words[i * STRIDE + W_COLOR]! >>> 24 === 0
          ? 255
          : kind < 4 && (flags & FLAG_ELLIPSE) !== 0
            ? kind + 8
            : kind;
    }
  }

  uploadOverlay(f32: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
    if (count > this.overlayCapacity) {
      this.overlayCapacity = Math.max(count, 16) * 2;
      gl.bufferData(gl.ARRAY_BUFFER, this.overlayCapacity * STRIDE_BYTES, gl.DYNAMIC_DRAW);
    }
    if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32, 0, count * STRIDE);
  }

  /** Instances the GPU buffer can hold without a full re-upload. */
  get capacity() {
    return this.bufferCapacity;
  }

  begin(
    view: ViewUniforms,
    background: Float32Array,
    atlas: WebGLTexture | null,
    table: WebGLTexture | null,
  ) {
    const gl = this.gl;
    gl.viewport(0, 0, view.width, view.height);
    gl.clearColor(background[0]!, background[1]!, background[2]!, background[3]!);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    this.boundKind = -1;
    this.frame++;
    this.view = view;
    this.compositeLayer = false;
    gl.uniform4f(this.uView, view.scale, 0, view.tx, view.ty);
    gl.uniform2f(this.uViewport, view.width, view.height);
    gl.uniform4f(this.uWorldView, view.x0, view.y0, view.x1, view.y1);
    gl.uniform1f(this.uFlipY, view.flipY);
    gl.uniform1i(this.uCompositeLayer, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, table);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.drawCalls = 0;
  }

  /** Rebinds the scene program after an effect pass used its own. */
  resume() {
    this.gl.useProgram(this.program);
    this.boundKind = -1;
  }

  /** A layer applies its outer opacity when compositing instead of per primitive. */
  setCompositeLayer(enabled: boolean) {
    this.resume();
    this.compositeLayer = enabled;
    this.gl.uniform1i(this.uCompositeLayer, enabled ? 1 : 0);
  }

  /** Draws scene instances [start, end). */
  drawRange(start: number, end: number) {
    if (end <= start) return;
    if (this.specialized.size === 0) {
      this.drawInstances(start, end);
      return;
    }
    let runs = 0;
    let previous = -1;
    for (let i = start; i < end; i++) {
      const kind = this.kinds[i]!;
      if (kind !== previous && kind !== 255 && ++runs > MAX_SPECIALIZED_RUNS) {
        if (this.boundKind !== -1) this.resume();
        this.drawInstances(start, end);
        return;
      }
      previous = kind;
    }
    for (let from = start; from < end;) {
      const kind = this.kinds[from]!;
      let to = from + 1;
      while (to < end && this.kinds[to] === kind) to++;
      if (kind !== 255) {
        this.bindProgram(kind);
        this.drawInstances(from, to);
      }
      from = to;
    }
  }

  private bindProgram(kind: number) {
    const program = this.specialized.get(kind);
    if (!program) {
      if (this.boundKind !== -1) this.resume();
      return;
    }
    const gl = this.gl;
    if (this.boundKind !== kind) {
      gl.useProgram(program.program);
      this.boundKind = kind;
    }
    const view = this.view!;
    if (program.frame !== this.frame) {
      gl.uniform4f(program.view, view.scale, 0, view.tx, view.ty);
      gl.uniform2f(program.viewport, view.width, view.height);
      gl.uniform4f(program.worldView, view.x0, view.y0, view.x1, view.y1);
      gl.uniform1f(program.flipY, view.flipY);
      program.frame = this.frame;
    }
    if (program.composite !== this.compositeLayer) {
      gl.uniform1i(program.compositeLayer, this.compositeLayer ? 1 : 0);
      program.composite = this.compositeLayer;
    }
  }

  private drawInstances(start: number, end: number) {
    const gl = this.gl;
    gl.bindVertexArray(this.sceneVao);
    if (this.boundBase !== start) {
      // WebGL2 has no base-instance draw, so re-point the attributes instead.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sceneBuffer);
      this.pointAttributes(start, false);
      this.boundBase = start;
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - start);
    this.drawCalls++;
  }

  drawOverlay(count: number) {
    if (count === 0) return;
    if (this.boundKind !== -1) this.resume();
    const gl = this.gl;
    gl.bindVertexArray(this.overlayVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    this.drawCalls++;
  }

  end() {
    this.gl.bindVertexArray(null);
  }

  destroy() {
    for (const { program } of this.specialized.values()) this.gl.deleteProgram(program);
    this.specialized.clear();
    const gl = this.gl;
    gl.deleteBuffer(this.sceneBuffer);
    gl.deleteBuffer(this.overlayBuffer);
    gl.deleteVertexArray(this.sceneVao);
    gl.deleteVertexArray(this.overlayVao);
    gl.deleteProgram(this.program);
  }
}
