/** Ordered (Bayer 4x4) dithering on a square-cell grid, the look of the hero widgets. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16));

export function bayer(column: number, row: number): number {
  return BAYER[row & 3]![column & 3]!;
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
