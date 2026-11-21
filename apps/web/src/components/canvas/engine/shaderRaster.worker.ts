import type { CanvasPaint } from "@t3tools/contracts";

export type ShaderPaint = Extract<CanvasPaint, { type: "shader" }>;
export interface ShaderRasterRequest {
  readonly id: number;
  readonly paint: ShaderPaint;
  readonly width: number;
  readonly height: number;
  readonly time: number;
}
export type ShaderRasterResponse =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };

const canvas = new OffscreenCanvas(1, 1);
const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
interface Program {
  program: WebGLProgram;
  uniforms: Map<string, { location: WebGLUniformLocation; type: number; size: number }>;
}
const programs = new Map<string, Program>();
let vertices: WebGLBuffer | null = null;

function compile(type: number, source: string) {
  if (!gl) throw new Error("Shader fills require worker WebGL1 support");
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "Shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(error);
  }
  return shader;
}

function programFor(source: string): Program {
  if (!gl) throw new Error("Shader fills require worker WebGL1 support");
  const existing = programs.get(source);
  if (existing) {
    programs.delete(source);
    programs.set(source, existing);
    return existing;
  }
  const fragment = compile(gl.FRAGMENT_SHADER, source);
  let vertex: WebGLShader | null = null;
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(fragment);
    throw new Error("Could not allocate shader program");
  }
  try {
    vertex = compile(
      gl.VERTEX_SHADER,
      "attribute vec2 a_position; void main(){gl_Position=vec4(a_position,0.0,1.0);}",
    );
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "a_position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Shader linking failed");
    const uniforms: Program["uniforms"] = new Map();
    const count: number = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (location)
        uniforms.set(info.name.replace(/\[0\]$/, ""), {
          location,
          type: info.type,
          size: info.size,
        });
    }
    const result = { program, uniforms };
    programs.set(source, result);
    if (programs.size > 16) {
      const oldest = programs.entries().next().value;
      if (oldest) {
        gl.deleteProgram(oldest[1].program);
        programs.delete(oldest[0]);
      }
    }
    return result;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(fragment);
    if (vertex) gl.deleteShader(vertex);
  }
}

function color(value: string): number[] {
  if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))
    throw new Error(`Unsupported shader color: ${value}`);
  let hex = value.slice(1);
  if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  channels.push(hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1);
  return channels;
}

function render(request: ShaderRasterRequest) {
  if (!gl || gl.isContextLost()) throw new Error("Shader WebGL context is unavailable");
  const { paint, width, height, time } = request;
  const program = programFor(paint.source);
  canvas.width = width;
  canvas.height = height;
  gl.viewport(0, 0, width, height);
  gl.useProgram(program.program);
  if (!vertices) {
    vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  } else gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  for (const [name, uniform] of program.uniforms) {
    const supplied =
      name === paint.timeUniform
        ? time
        : name === paint.resolutionUniform
          ? [width, height]
          : paint.uniforms?.[name];
    let values =
      typeof supplied === "string"
        ? color(supplied)
        : typeof supplied === "number"
          ? [supplied]
          : supplied;
    const { type, location, size } = uniform;
    let components = 1;
    if (type === gl.FLOAT_VEC2 || type === gl.INT_VEC2 || type === gl.BOOL_VEC2) components = 2;
    else if (type === gl.FLOAT_VEC3 || type === gl.INT_VEC3 || type === gl.BOOL_VEC3)
      components = 3;
    else if (type === gl.FLOAT_VEC4 || type === gl.INT_VEC4 || type === gl.BOOL_VEC4)
      components = 4;
    else if (type !== gl.FLOAT && type !== gl.INT && type !== gl.BOOL)
      throw new Error(`Unsupported shader uniform ${name} (WebGL type ${type})`);
    const length = components * size;
    if (values === undefined) values = Array.from({ length }, () => 0);
    if (typeof supplied === "string") values = values.slice(0, length);
    if (values.length !== length)
      throw new Error(`Shader uniform ${name} requires ${length} values`);
    const floats = new Float32Array(values);
    if (type === gl.FLOAT) gl.uniform1fv(location, floats);
    else if (type === gl.FLOAT_VEC2) gl.uniform2fv(location, floats);
    else if (type === gl.FLOAT_VEC3) gl.uniform3fv(location, floats);
    else if (type === gl.FLOAT_VEC4) gl.uniform4fv(location, floats);
    else {
      const integers = new Int32Array(values);
      if (components === 1) gl.uniform1iv(location, integers);
      else if (components === 2) gl.uniform2iv(location, integers);
      else if (components === 3) gl.uniform3iv(location, integers);
      else gl.uniform4iv(location, integers);
    }
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`Shader rendering failed (WebGL error ${error})`);
  return canvas.transferToImageBitmap();
}

self.addEventListener("message", (event: MessageEvent<ShaderRasterRequest>) => {
  const { id } = event.data;
  try {
    const bitmap = render(event.data);
    self.postMessage({ id, bitmap } satisfies ShaderRasterResponse, { transfer: [bitmap] });
  } catch (error) {
    self.postMessage(
      {
        id,
        // oxlint-disable-next-line t3code/no-untranslated-copy -- worker error detail, reported raw like a thrown error message
        error: error instanceof Error ? error.message : "Shader rendering failed",
      } satisfies ShaderRasterResponse,
      { transfer: [] },
    );
  }
});
