/** Ordered (Bayer 4x4) dithering on a square-cell grid, the look of the hero widgets. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16));

function bayer(column: number, row: number): number {
  return BAYER[row & 3]![column & 3]!;
}

function sample(values: ReadonlyArray<number>, t: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const position = t * (values.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  const next = values[Math.min(index + 1, values.length - 1)]!;
  return values[index]! * (1 - fraction) + next * fraction;
}

/**
 * A dithered area chart. `values` are 0..1 of the height. The two cells under the crest are
 * solid and density fades with depth, so the shape stays legible at any size.
 */
export function drawDitherArea(
  context: CanvasRenderingContext2D,
  height: number,
  values: ReadonlyArray<number>,
  options: {
    readonly color: string;
    readonly crest?: string;
    readonly cell?: number;
    readonly fade?: number;
    readonly x0: number;
    readonly x1: number;
  },
) {
  const cell = options.cell ?? 3;
  const fade = options.fade ?? 0.85;
  const columns = Math.floor((options.x1 - options.x0) / cell);
  const rows = Math.ceil(height / cell);
  const columnOffset = Math.floor(options.x0 / cell);
  for (let column = 0; column < columns; column += 1) {
    const value = Math.min(1, Math.max(0, sample(values, column / Math.max(1, columns - 1))));
    if (value <= 0) continue;
    const top = height * (1 - value);
    const firstRow = Math.floor(top / cell);
    for (let row = firstRow; row < rows; row += 1) {
      const density =
        row - firstRow < 2 ? 1 : 1 - ((row * cell - top) / (height - top + 1e-3)) * fade;
      if (density <= bayer(column + columnOffset, row)) continue;
      context.fillStyle = row === firstRow && options.crest ? options.crest : options.color;
      context.fillRect(options.x0 + column * cell, row * cell, cell - 1, cell - 1);
    }
  }
}

/** Fills a rectangle with dithered cells; `density` may vary per cell. Unlit cells take `ghost`. */
export function drawDitherField(
  context: CanvasRenderingContext2D,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  density: number | ((column: number, row: number) => number),
  color: string,
  options: { readonly cell?: number; readonly ghost?: string } = {},
) {
  const cell = options.cell ?? 3;
  for (let row = 0; row * cell < rect.height; row += 1) {
    for (let column = 0; column * cell < rect.width; column += 1) {
      const value = typeof density === "function" ? density(column, row) : density;
      const lit = value > bayer(column, row);
      if (!lit && !options.ghost) continue;
      context.fillStyle = lit ? color : options.ghost!;
      context.fillRect(rect.x + column * cell, rect.y + row * cell, cell - 1, cell - 1);
    }
  }
}

export function drawDottedLine(
  context: CanvasRenderingContext2D,
  from: readonly [number, number],
  to: readonly [number, number],
  color: string,
  step = 4,
  size = 2,
) {
  const steps = Math.max(1, Math.hypot(to[0] - from[0], to[1] - from[1]) / step);
  context.fillStyle = color;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    context.fillRect(
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      size,
      size,
    );
  }
}
