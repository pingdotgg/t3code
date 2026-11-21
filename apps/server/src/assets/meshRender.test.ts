import { describe, expect, it } from "vite-plus/test";

import { renderMesh } from "./meshRender.ts";

const signal = new AbortController().signal;

/** A unit cube as twelve triangles. */
const CUBE = (() => {
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  return faces.flatMap(([a, b, c, d]) => [
    [...corners[a!]!, ...corners[b!]!, ...corners[c!]!],
    [...corners[a!]!, ...corners[c!]!, ...corners[d!]!],
  ]);
})();

describe("renderMesh", () => {
  const options = { size: 64, supersample: 2, workPerSlice: 100 };

  it("draws a shaded, centered model on a transparent background", async () => {
    const image = await renderMesh(
      { points: Float32Array.from(CUBE.flat()), indices: null },
      signal,
      options,
    );
    expect(image).not.toBeNull();
    const { width, height, rgba } = image!;
    expect(Math.max(width, height)).toBe(64);
    const alpha = (x: number, y: number) => rgba[(y * width + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(Math.floor(width / 2), Math.floor(height / 2))).toBe(255);
    // Three faces are visible from the three-quarter view, each lit differently.
    const shades = new Set<number>();
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      if (rgba[pixel * 4 + 3] === 255) shades.add(rgba[pixel * 4]!);
    }
    expect(shades.size).toBeGreaterThanOrEqual(3);
  });

  it("returns null for flat-to-a-point or non-finite geometry", async () => {
    expect(
      await renderMesh({ points: new Float32Array(9), indices: null }, signal, options),
    ).toBeNull();
    expect(
      await renderMesh(
        { points: Float32Array.of(0, 0, 0, 1, 0, 0, NaN, 0, 0), indices: null },
        signal,
        options,
      ),
    ).toBeNull();
  });

  it("stops when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderMesh(
        { points: Float32Array.from(CUBE.flat()), indices: null },
        controller.signal,
        options,
      ),
    ).rejects.toThrow();
  });
});
