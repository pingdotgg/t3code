import type { ThemeBackdrop } from "@t3tools/shared/themePalettes";

const BACKDROP_DATA_ATTRIBUTE = "themeBackdrop";
const BACKDROP_OPACITY_VARIABLE = "--theme-backdrop-surface-opacity";
const DEFAULT_FPS = 30;
const DEFAULT_SURFACE_OPACITY = 0.35;
const DAYLIGHT_REFRESH_MS = 60_000;

let activeBackdrop: ThemeBackdrop | null = null;
const listeners = new Set<() => void>();

function backdropEqual(a: ThemeBackdrop | null, b: ThemeBackdrop | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.glsl === b.glsl && a.fps === b.fps && a.opacity === b.opacity;
}

function resolveBackdrop(backdrop: ThemeBackdrop | undefined): ThemeBackdrop | null {
  if (backdrop === undefined || backdrop.glsl.trim().length === 0) return null;
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

export function mountThemeBackdropCanvas(
  canvas: HTMLCanvasElement,
  backdrop: ThemeBackdrop,
): () => void {
  const fragmentSource = backdrop.glsl.trim();
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
