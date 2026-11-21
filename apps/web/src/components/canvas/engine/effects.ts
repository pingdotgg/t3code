/**
 * Group opacity and blur need offscreen layers clipped to the subtree's scissor box.
 * Blur downsamples to keep its separable kernel small, then composites with bilinear upsampling.
 */

const VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
// Source uv per full-resolution px, and destination px size in full-resolution px.
uniform vec2 uSrcScale;
uniform float uDstScale;
// 0 copy, 1 downsample, 2 blur.
uniform int uMode;
uniform vec2 uDir;
uniform int uRadius;
uniform float uWeights[25];
uniform float uTotal;
uniform float uOpacity;
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy * uDstScale;
  vec2 uv = p * uSrcScale;
  if (uMode == 1) {
    vec2 o = 0.25 * uDstScale * uSrcScale;
    outColor = 0.25 * (
      texture(uSrc, uv + vec2(-o.x, -o.y)) + texture(uSrc, uv + vec2(o.x, -o.y)) +
      texture(uSrc, uv + vec2(-o.x, o.y)) + texture(uSrc, uv + vec2(o.x, o.y))
    );
    return;
  }
  if (uMode == 2) {
    vec2 step = uDir * uDstScale * uSrcScale;
    vec4 sum = texture(uSrc, uv);
    for (int i = 1; i <= 24; i++) {
      if (i > uRadius) break;
      float w = uWeights[i];
      sum += w * (texture(uSrc, uv + step * float(i)) + texture(uSrc, uv - step * float(i)));
    }
    outColor = sum / uTotal;
    return;
  }
  outColor = texture(uSrc, uv) * uOpacity;
}
`;

/** Downsample factor that keeps a blur kernel 2-4 texels wide. */
const blurScale = (sigma: number) =>
  Math.min(32, 2 ** Math.max(0, Math.floor(Math.log2(sigma / 2))));

/** Kernel radius in downsampled texels, plus one for bilinear taps. */
const blurRadius = (sigma: number) => Math.ceil((3 * sigma) / blurScale(sigma)) + 1;

interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

/** Scissor box in GL framebuffer px (origin bottom-left). */
export interface LayerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class EffectLayers {
  private program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private layer: Target | null = null;
  /** Blur ping-pong targets per downsample factor. */
  private small = new Map<number, [Target, Target]>();
  private width = 0;
  private height = 0;
  private kernelSigma = -1;
  private readonly kernel = new Float32Array(25);

  constructor(private readonly gl: WebGL2RenderingContext) {
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(`Canvas effect shader failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    this.program = program;
    for (const name of [
      "uSrc",
      "uSrcScale",
      "uDstScale",
      "uMode",
      "uDir",
      "uRadius",
      "uWeights[0]",
      "uTotal",
      "uOpacity",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.useProgram(program);
    gl.uniform1i(this.uniforms.uSrc!, 2);
    this.vao = gl.createVertexArray();
  }

  private makeTarget(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, fbo, width, height };
  }

  private freeTarget(target: Target) {
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.fbo);
  }

  /** Frees every layer texture. */
  release() {
    if (this.layer) this.freeTarget(this.layer);
    this.layer = null;
    for (const [a, b] of this.small.values()) {
      this.freeTarget(a);
      this.freeTarget(b);
    }
    this.small.clear();
    this.width = 0;
    this.height = 0;
  }

  /**
   * Binds the full-size layer for a target of `width` x `height`, cleared inside
   * `box` plus what a `sigma` blur reads. The caller draws the subtree with the
   * scene program afterwards.
   */
  begin(width: number, height: number, box: LayerBox, sigma: number) {
    const gl = this.gl;
    if (this.width !== width || this.height !== height) {
      this.release();
      this.width = width;
      this.height = height;
    }
    this.layer ??= this.makeTarget(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layer.fbo);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    const margin = sigma >= 0.5 ? (blurRadius(sigma) * 2 + 2) * blurScale(sigma) : 0;
    this.scissor(box, margin, 1, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Scissors to `box` (full-size px) grown by `margin`, in a target downsampled by `scale`. */
  private scissor(box: LayerBox, margin: number, scale: number, width: number, height: number) {
    const x0 = Math.max(0, Math.floor((box.x - margin) / scale));
    const y0 = Math.max(0, Math.floor((box.y - margin) / scale));
    const x1 = Math.min(width, Math.ceil((box.x + box.width + margin) / scale));
    const y1 = Math.min(height, Math.ceil((box.y + box.height + margin) / scale));
    this.gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  }

  /**
   * Blurs the layer by `sigma` px (gaussian standard deviation) and draws it
   * over `target` inside `box` at `opacity`. Leaves the effect program bound.
   */
  composite(target: WebGLFramebuffer | null, box: LayerBox, sigma: number, opacity: number) {
    const gl = this.gl;
    const layer = this.layer!;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE2);
    gl.disable(gl.BLEND);
    let source = layer;
    let scale = 1;
    if (sigma >= 0.5) {
      // Downsample until the kernel is 2-4 texels wide; bilinear upsampling hides the rest.
      scale = blurScale(sigma);
      const radius = blurRadius(sigma);
      let pair = this.small.get(scale);
      if (!pair) {
        const w = Math.ceil(this.width / scale);
        const h = Math.ceil(this.height / scale);
        pair = [this.makeTarget(w, h), this.makeTarget(w, h)];
        this.small.set(scale, pair);
      }
      const [a, b] = pair;
      gl.viewport(0, 0, a.width, a.height);
      gl.uniform1f(u.uDstScale!, scale);
      // Every pixel uses the same kernel. Upload it once instead of computing
      // exponentials and normalization in each fragment of both blur passes.
      const kernelSigma = Math.fround(sigma / scale);
      if (this.kernelSigma !== kernelSigma) {
        const radius = Math.min(24, Math.ceil(Math.fround(kernelSigma * 3)));
        const denominator = Math.fround(Math.fround(2 * kernelSigma) * kernelSigma);
        let total = 1;
        this.kernel[0] = 1;
        for (let i = 1; i <= radius; i++) {
          const weight = Math.fround(Math.exp(Math.fround(-(i * i) / denominator)));
          this.kernel[i] = weight;
          total = Math.fround(total + Math.fround(2 * weight));
        }
        gl.uniform1i(u.uRadius!, radius);
        gl.uniform1fv(u["uWeights[0]"]!, this.kernel);
        gl.uniform1f(u.uTotal!, total);
        this.kernelSigma = kernelSigma;
      }
      gl.uniform1f(u.uOpacity!, 1);
      // Each pass writes a margin wide enough for the reads of the next one.
      const pass = (
        from: Target,
        to: Target,
        mode: number,
        srcScale: number,
        dx: number,
        margin: number,
      ) => {
        this.scissor(box, margin * scale, scale, to.width, to.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
        gl.bindTexture(gl.TEXTURE_2D, from.texture);
        gl.uniform2f(u.uSrcScale!, 1 / (from.width * srcScale), 1 / (from.height * srcScale));
        gl.uniform1i(u.uMode!, mode);
        gl.uniform2f(u.uDir!, dx, 1 - dx);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      if (scale > 1) pass(layer, a, 1, 1, 0, radius * 2 + 1);
      pass(scale > 1 ? a : layer, b, 2, scale, 1, radius + 1);
      pass(b, a, 2, scale, 0, 1);
      source = a;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);
    this.scissor(box, 0, 1, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform2f(u.uSrcScale!, 1 / (source.width * scale), 1 / (source.height * scale));
    gl.uniform1f(u.uDstScale!, 1);
    gl.uniform1i(u.uMode!, 0);
    gl.uniform1f(u.uOpacity!, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
  }

  destroy() {
    this.release();
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
