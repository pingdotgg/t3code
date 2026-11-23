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
  return a.shader === b.shader && a.glsl === b.glsl && a.fps === b.fps && a.opacity === b.opacity;
}

function resolveBackdrop(backdrop: ThemeBackdrop | undefined): ThemeBackdrop | null {
  if (backdrop === undefined) return null;
  if (backdrop.shader === undefined && (!backdrop.glsl || backdrop.glsl.trim().length === 0)) {
    return null;
  }
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

/**
 * GLSL ES 3.00 port of the Nimbus 5x7 bitmap ASCII landscape shader:
 * crescent moon with maria & halo, moon-lit FBM clouds, cirrus veil,
 * three mountain ridges with snow & valley mist, pine trees, Milky Way dust,
 * twinkling stars, and periodic shooting stars tinted by time-of-day.
 */
export const NIMBUS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_daylight;
uniform float u_dark;

out vec4 fragColor;

const float CELL = 6.0;
const float LINE = 12.0;
const float DOT = 1.0;
const float ZOOM = 1.4;
const float ASPECT = CELL / LINE;

const int PERIOD = 1;
const int COLON = 2;
const int DASH = 3;
const int PLUS = 5;
const int STAR = 6;
const int CARET = 10;
const int SLASH = 11;
const int BACKSLASH = 12;
const int PIPE = 13;
const int UNDERSCORE = 14;
const int TILDE = 15;
const int TICK = 16;

const float MOON_ACROSS = 0.64;
const float METEOR_EVERY = 9.0;
const float METEOR_SECONDS = 0.9;
const float METEOR_ROWS = 13.0;
const float METEOR_TAIL = 8.0;

float clamp01(float v) {
  return clamp(v, 0.0, 1.0);
}

float hash2(float x, float y) {
  float a = mod(x, 1021.0);
  float b = mod(y, 1021.0);
  float h1 = mod(a * 17.0 + b * 131.0 + 7.0, 4091.0);
  float h2 = mod(h1 * h1 + a * 29.0 + 11.0, 4091.0);
  return mod(h2 * h2 + b * 37.0 + a + 5.0, 4091.0) / 4091.0;
}

float noise2(float x, float y) {
  float xi = floor(x);
  float yi = floor(y);
  float xf = x - xi;
  float yf = y - yi;
  float u = xf * xf * (3.0 - 2.0 * xf);
  float v = yf * yf * (3.0 - 2.0 * yf);
  float a = hash2(xi, yi);
  float b = hash2(xi + 1.0, yi);
  float c = hash2(xi, yi + 1.0);
  float d = hash2(xi + 1.0, yi + 1.0);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

float fbm(float x, float y) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise2(x * freq, y * freq);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.875;
}

float wisps(float x, float y) {
  return (noise2(x, y) * 2.0 + noise2(x * 2.03, y * 2.03)) / 3.0;
}

float tent(float x, float seed) {
  float xi = floor(x);
  return mix(hash2(xi, seed), hash2(xi + 1.0, seed), x - xi);
}

float peaks(float x, float seed) {
  return (tent(x, seed) + 0.4 * tent(x * 2.7, seed + 1.0) + 0.16 * tent(x * 6.1, seed + 2.0)) / 1.56;
}

int bitsLow(int g) {
  if (g == 1) return 0;
  if (g == 2) return 12672;
  if (g == 3) return 31;
  if (g == 4) return 992;
  if (g == 5) return 4255;
  if (g == 6) return 4782;
  if (g == 7) return 338922;
  if (g == 8) return 812100;
  if (g == 9) return 476917;
  if (g == 10) return 141856;
  if (g == 11) return 33860;
  if (g == 12) return 540932;
  if (g == 13) return 135300;
  if (g == 14) return 0;
  if (g == 15) return 277;
  return 135168;
}

int bitsHigh(int g) {
  if (g == 1) return 396;
  if (g == 2) return 12672;
  if (g == 3) return 0;
  if (g == 4) return 31744;
  if (g == 5) return 4224;
  if (g == 6) return 21632;
  if (g == 7) return 32074;
  if (g == 8) return 8803;
  if (g == 9) return 24079;
  if (g == 10) return 0;
  if (g == 11) return 8720;
  if (g == 12) return 2081;
  if (g == 13) return 4228;
  if (g == 14) return 31;
  if (g == 15) return 2048;
  return 0;
}

float inGlyph(int g, int gx, int gy) {
  int word = gy < 4 ? bitsLow(g) : bitsHigh(g);
  int row = gy < 4 ? (3 - gy) : (6 - gy);
  int shift = row * 5 + (4 - gx);
  return float((word >> shift) & 1);
}

float farRidge(float x, float rows) {
  return floor(rows * (0.9 - 0.4 * peaks((x * 0.04) / ZOOM + 3.1, 11.0)));
}

float midRidge(float x, float rows) {
  return floor(rows * (0.95 - 0.2 * peaks((x * 0.075) / ZOOM + 9.4, 23.0)));
}

float nearHill(float x, float rows) {
  return floor(rows * (0.975 - 0.05 * tent((x * 0.045) / ZOOM + 2.2, 37.0)));
}

int ridgeEdge(float left, float top, float right, float y) {
  if (left > y && right > y) return y == top ? CARET : PIPE;
  if (left > y) return SLASH;
  if (right > y) return BACKSLASH;
  if (y == top) return UNDERSCORE;
  return 0;
}

void main() {
  float t = u_time;
  vec2 point = gl_FragCoord.xy;
  float cols = floor(u_resolution.x / CELL) + 1.0;
  float rows = floor(u_resolution.y / LINE) + 1.0;
  float x = floor(point.x / CELL);
  float py = u_resolution.y - point.y;
  float y = floor(py / LINE);
  float xn = x / cols;
  float yn = y / rows;

  float moonX = cols * MOON_ACROSS;
  float moonY = rows * 0.21;
  float moonR = clamp(rows * 0.115, 4.0 * ZOOM, 9.0 * ZOOM);
  float dx = (x - moonX) * ASPECT;
  float dy = y - moonY;
  float moonD = sqrt(dx * dx + dy * dy) / moonR;
  float glow = exp(-moonD * moonD * 0.16);

  float far = farRidge(x, rows);
  float mid = midRidge(x, rows);
  float near = nearHill(x, rows);

  float threshold = 0.5 + 0.8 * smoothstep(0.1, 0.44, yn) + 0.4 * exp(-moonD * moonD * 0.3);
  float nx = (x * 0.05) / ZOOM + t * 0.05;
  float ny = (y * 0.1) / ZOOM + t * 0.006;
  float n = fbm(nx, ny);
  float density = clamp01((n - threshold) / 0.16);
  float high = wisps((x * 0.03) / ZOOM + t * 0.016 + 40.0, (y * 0.09) / ZOOM + 7.0);
  float veil = clamp01((high - 0.5 - 0.7 * smoothstep(0.1, 0.5, yn)) / 0.2);

  float tree = floor(x / 4.0);
  float treeAt = mod(x, 4.0);
  float treeRoot = nearHill(tree * 4.0 + 1.0, rows);
  float treeTall = hash2(tree, 71.0) < tent((tree * 0.3) / ZOOM, 79.0) ? 2.0 + floor(hash2(tree, 73.0) * 4.0) : 0.0;
  float treeUp = treeRoot - y;

  float epoch = floor(t / METEOR_EVERY);
  float flight = (t - epoch * METEOR_EVERY) / METEOR_SECONDS;
  float meteorX = floor(cols * (0.12 + 0.5 * hash2(epoch, 5.0)));
  float meteorY = floor(rows * (0.26 + 0.2 * hash2(epoch, 9.0)));
  float fallen = y - meteorY;
  float behind = flight * METEOR_ROWS - fallen;
  float across = x - (meteorX - 2.0 * fallen);

  float band = abs(yn - 0.14 - 0.52 * xn);
  float dust = clamp01(1.0 - band / 0.1) * (1.0 - glow);
  float sparkle = hash2(x, y * 7.0 + 3.0);

  int glyph = 0;
  float bright = 0.0;
  if (y >= near) {
    if (hash2(x, y + 50.0) > 0.72) {
      glyph = PERIOD;
      bright = 0.1;
    }
  } else if (treeTall > 0.0 && treeUp > 0.0 && treeUp <= treeTall && treeAt < 3.0) {
    if (treeUp == treeTall) {
      if (treeAt == 1.0) {
        glyph = CARET;
        bright = 0.34;
      }
    } else {
      glyph = treeAt == 0.0 ? SLASH : (treeAt == 1.0 ? PIPE : BACKSLASH);
      bright = 0.26;
    }
  } else if (y >= mid) {
    glyph = ridgeEdge(midRidge(x - 1.0, rows), mid, midRidge(x + 1.0, rows), y);
    if (glyph > 0) {
      bright = 0.36;
    } else if (hash2(x, y + 90.0) > 0.7) {
      glyph = PERIOD;
      bright = 0.13;
    }
  } else {
    float fog = wisps((x * 0.05) / ZOOM + t * 0.014 + 70.0, (y * 0.5) / ZOOM + 13.0);
    float lying = 1.0 - abs(yn - 0.85) / 0.08;
    float mist = clamp01((fog - 0.5) / 0.16) * clamp01(lying * 2.0);
    if (mist > 0.2 && y >= far - 1.0 && hash2(x, y + 60.0) < 0.35 + 0.6 * mist) {
      glyph = mist > 0.6 ? TILDE : DASH;
      bright = 0.12 + 0.18 * mist;
    } else if (y >= far) {
      float left = farRidge(x - 1.0, rows);
      float right = farRidge(x + 1.0, rows);
      float depth = y - far;
      float rise = farRidge(x - 11.0, rows) - farRidge(x + 11.0, rows);
      bool facing = xn < MOON_ACROSS ? rise < 0.0 : rise > 0.0;
      float snow = (rows * 0.68 - far) * 0.6 - depth - 2.0 * hash2(x, 31.0);
      int rim = ridgeEdge(left, far, right, y);
      if (rim > 0) {
        glyph = rim;
        bright = (facing ? 0.7 : 0.42) + 0.25 * glow;
      } else if (snow > 0.0) {
        glyph = facing ? (hash2(x, y + 12.0) > 0.5 ? STAR : PLUS) : COLON;
        bright = facing ? 0.6 : 0.26;
      } else if (facing) {
        float grain = hash2(x, y + 90.0);
        glyph = grain > 0.8 ? COLON : (grain > 0.3 ? PERIOD : 0);
        bright = 0.24;
      } else if (hash2(x, y + 90.0) > 0.7) {
        glyph = PERIOD;
        bright = 0.14;
      }
    } else if (density > 0.3) {
      float lit = clamp01(0.5 + (n - fbm(nx + (x < moonX ? 0.07 : -0.07), ny - 0.06)) * 5.0);
      float shade = density * (0.35 + 0.65 * lit);
      glyph = min(9, 1 + int(floor(shade * 9.0)));
      bright = mix(0.3, 0.92, lit) * (0.5 + 0.5 * density) * (0.72 + 0.5 * glow);
      bright = bright * mix(0.4, 1.0, smoothstep(40.0, 150.0, py));
    } else if (moonD < 1.0) {
      float limb = sqrt(max(0.0, 1.0 - moonD * moonD));
      float seas = smoothstep(0.46, 0.66, fbm((dx * 0.3) / ZOOM + 5.3, (dy * 0.3) / ZOOM + 2.1));
      float sx = dx + moonR * 0.55;
      float sy = dy + moonR * 0.14;
      float shadow = sqrt(sx * sx + sy * sy) / moonR;
      if (shadow > 1.0) {
        float shade = (0.72 + 0.28 * limb) * (1.0 - 0.42 * seas) * smoothstep(0.98, 1.06, shadow);
        glyph = min(9, 4 + int(floor(shade * 6.0)));
        bright = 0.3 + 0.7 * shade;
      } else if (hash2(x, y + 20.0) > 0.55) {
        glyph = PERIOD;
        bright = 0.16;
      }
    } else if (density > 0.0) {
      glyph = density > 0.15 ? COLON : PERIOD;
      bright = 0.26 + 0.5 * glow;
    } else if (veil > 0.0 && hash2(x + 3.0, y + 110.0) < 0.25 + 0.6 * veil) {
      glyph = veil > 0.6 ? COLON : PERIOD;
      bright = 0.13 + 0.12 * veil + 0.3 * glow;
    } else if (moonD < 1.7 && hash2(x, y + 20.0) > 0.25 + (moonD - 1.0)) {
      glyph = moonD < 1.25 ? COLON : PERIOD;
      bright = 0.5 - 0.4 * (moonD - 1.0);
    } else if (
      flight < 2.0 && fallen >= 0.0 && fallen <= METEOR_ROWS && behind >= 0.0
      && behind < METEOR_TAIL && across >= 0.0 && across < 2.0
    ) {
      bool head = behind < 1.0;
      glyph = head ? (across == 0.0 ? STAR : TICK) : (across == 0.0 ? SLASH : PERIOD);
      bright = (head ? 1.0 : 0.75 - behind * 0.08) * clamp01(2.0 - flight);
    } else if (sparkle > 0.988 - 0.009 * dust) {
      float twinkle = 0.5 + 0.5 * sin(t * (0.6 + mod(sparkle * 400.0, 2.0)) + sparkle * 1000.0);
      glyph = sparkle > 0.9985 ? STAR : (sparkle > 0.9955 ? PLUS : PERIOD);
      bright = (0.22 + 0.55 * twinkle) * (1.0 - 0.5 * smoothstep(0.5, 0.8, yn));
    } else if (
      dust > 0.0 && hash2(x + 7.0, y + 140.0) < dust * (0.1 + 0.3 * noise2((x * 0.08) / ZOOM, (y * 0.16) / ZOOM))
    ) {
      glyph = hash2(x, y + 33.0) > 0.82 ? COLON : PERIOD;
      bright = 0.12 + 0.14 * dust;
    }
  }

  int gx = int(floor((point.x - x * CELL - 0.5) / DOT));
  int gy = int(floor((py - y * LINE - 2.5) / DOT));
  float on = (glyph > 0 && gx >= 0 && gx < 5 && gy >= 0 && gy < 7) ? inGlyph(glyph, gx, gy) : 0.0;

  float hx = (point.x / CELL - moonX) * ASPECT;
  float hy = py / LINE - moonY;
  float halo = exp(-(hx * hx + hy * hy) / (moonR * moonR * 7.0));
  float sky = 0.014 + 0.05 * halo * (y < far ? 1.0 : 0.3);
  float c = mix(sky, 1.0, on * bright) * smoothstep(0.0, 1.6, t);
  float r = mix(1.0, 0.62, u_daylight);
  float g = mix(0.7, 0.84, u_daylight);
  float b = mix(0.5, 1.0, u_daylight);
  fragColor = vec4(c * r, c * g, c * b, 1.0);
}
`;

function resolveFragmentSource(backdrop: ThemeBackdrop): string | null {
  if (backdrop.glsl && backdrop.glsl.trim().length > 0) return backdrop.glsl;
  if (backdrop.shader === "nimbus") return NIMBUS_FRAGMENT_SHADER;
  return null;
}

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
  const fragmentSource = resolveFragmentSource(backdrop);
  if (fragmentSource === null) return () => {};

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
