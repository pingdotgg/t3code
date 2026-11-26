// Fork: number helpers, masks and dithering for Kaluwa's backdrop art. Pure, so tests and
// the render worker share them.

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Stable 0..1 hash of a cell and a seed. */
export const hash = (x: number, y: number, seed: number) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const valueNoise = (x: number, y: number, seed: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

export const fbm = (x: number, y: number, seed: number) =>
  valueNoise(x, y, seed) * 0.55 +
  valueNoise(x * 2.1, y * 2.1, seed + 11) * 0.3 +
  valueNoise(x * 4.3, y * 4.3, seed + 23) * 0.15;

/** 8×8 Bayer matrix, values 0..63. */
export const BAYER_8: ReadonlyArray<ReadonlyArray<number>> = (() => {
  let matrix: number[][] = [[0]];
  for (let step = 0; step < 3; step++) {
    const size = matrix.length;
    const next = Array.from({ length: size * 2 }, () => Array.from({ length: size * 2 }, () => 0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = matrix[y]![x]! * 4;
        next[y]![x] = value;
        next[y]![x + size] = value + 2;
        next[y + size]![x] = value + 3;
        next[y + size]![x + size] = value + 1;
      }
    }
    matrix = next;
  }
  return matrix;
})();

/** Ordered-dither threshold for a cell, in 0..1. */
export const bayerThreshold = (x: number, y: number) => (BAYER_8[y & 7]![x & 7]! + 0.5) / 64;

/**
 * How much the art fades under the composer: an ellipse centred just below the bottom edge.
 * Returns the multiplier for a cell at normalised (nx, ny).
 */
export const composerFadeFactor = (nx: number, ny: number, fade: number) => {
  const dx = (nx - 0.5) / 0.6;
  const dy = (ny - 1.02) / 0.44;
  return 1 - fade * clamp(1 - (dx * dx + dy * dy)) ** 0.7;
};

/** Dims a soft spot behind the new-thread headline so it stays readable. */
export const heroFadeFactor = (nx: number, ny: number, heroY: number, fade: number) => {
  const dx = (nx - 0.5) / 0.34;
  const dy = (ny - heroY) / 0.2;
  return 1 - 0.4 * fade * clamp(1 - (dx * dx + dy * dy));
};

/** "Bottom" placement keeps the lower part of the pane and clears the top. */
export const bottomPlacementFactor = (ny: number) => smoothstep(0.3, 0.78, ny);

export type ErrorDiffusionKind = "atkinson" | "floyd";

/**
 * Error-diffusion dither in place over a cols×rows field of 0..1 values. Returns 1 for each
 * cell that turns on. Values above 1 keep their excess so callers can find the hottest cells
 * in `field` afterwards.
 */
export function errorDiffusionDither(
  field: Float32Array,
  cols: number,
  rows: number,
  threshold: number,
  kind: ErrorDiffusionKind,
): Uint8Array {
  const on = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const old = clamp(field[index]!);
      const lit = old > threshold;
      const error = old - (lit ? 1 : 0);
      if (lit) on[index] = 1;
      if (kind === "floyd") {
        if (x + 1 < cols) field[index + 1]! += error * (7 / 16);
        if (y + 1 < rows) {
          if (x > 0) field[index + cols - 1]! += error * (3 / 16);
          field[index + cols]! += error * (5 / 16);
          if (x + 1 < cols) field[index + cols + 1]! += error * (1 / 16);
        }
      } else {
        // Atkinson spreads 6/8 of the error, which keeps highlights and shadows crisp.
        const share = error / 8;
        if (x + 1 < cols) field[index + 1]! += share;
        if (x + 2 < cols) field[index + 2]! += share;
        if (y + 1 < rows) {
          if (x > 0) field[index + cols - 1]! += share;
          field[index + cols]! += share;
          if (x + 1 < cols) field[index + cols + 1]! += share;
        }
        if (y + 2 < rows) field[index + 2 * cols]! += share;
      }
    }
  }
  return on;
}

/** Ordered (Bayer) dither: a cell turns on when its value beats the matrix threshold. */
export function orderedDither(
  field: Float32Array,
  cols: number,
  rows: number,
  threshold = 0.5,
): Uint8Array {
  const on = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      if (field[index]! > bayerThreshold(x, y) + threshold - 0.5) on[index] = 1;
    }
  }
  return on;
}

/** Relative luminance (0..1) of an sRGB pixel with contrast, brightness and invert applied. */
export function adjustedLuminance(
  r: number,
  g: number,
  b: number,
  contrast: number,
  brightness: number,
  invert: boolean,
): number {
  const gain = 1 + (contrast / 100) * (contrast > 0 ? 2 : 1);
  const lift = (brightness / 100) * 0.6;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const adjusted = clamp((luminance - 0.5) * gain + 0.5 + lift);
  return invert ? 1 - adjusted : adjusted;
}

/** Size that fits an image inside `max` on its longer side without enlarging it. */
export function downscaledSize(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Where an image lands for "fill" (cover) or "fit" (contain) with a focal point in 0..1. */
export function placeImage(
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  fit: "fill" | "fit",
  focusX: number,
  focusY: number,
) {
  const scale =
    fit === "fill"
      ? Math.max(width / imageWidth, height / imageHeight)
      : Math.min(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  return {
    x: (width - drawWidth) * focusX,
    y: (height - drawHeight) * focusY,
    width: drawWidth,
    height: drawHeight,
  };
}

/** Linear sRGB mix of two [r, g, b] colours. */
export function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}
