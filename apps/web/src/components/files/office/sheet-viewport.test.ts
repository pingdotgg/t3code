import { expect, it } from "vite-plus/test";
import { bufferedViewport, cachedViewport, retainCachedViewport } from "./sheet-viewport";

it.each([
  { x: 150, y: 400, expected: { x: 150, y: 400 } },
  { x: 50, y: 100, expected: { x: 100, y: 300 } },
  { x: 500, y: 1000, expected: { x: 300, y: 700 } },
])("keeps a viewport at ($x, $y) inside the cached bitmap", ({ x, y, expected }) => {
  expect(
    cachedViewport({ x: 100, y: 300, width: 800, height: 1000 }, { x, y, width: 600, height: 600 }),
  ).toEqual(expected);
});

it("keeps the cache origin when a resized viewport is larger than the bitmap", () => {
  expect(
    cachedViewport(
      { x: 100, y: 300, width: 400, height: 400 },
      { x: 50, y: 100, width: 600, height: 600 },
    ),
  ).toEqual({ x: 100, y: 300 });
});

it.each([
  { x: 0, y: 0 },
  { x: 50, y: 100 },
  { x: 1000, y: 2000 },
])("buffers both scroll directions without going past the sheet origin ($x, $y)", (point) => {
  const viewport = { ...point, width: 600, height: 600 };
  const frame = bufferedViewport(viewport);
  expect(frame.x).toBe(Math.max(0, point.x - 128));
  expect(frame.y).toBe(Math.max(0, point.y - 200));
  expect(frame.x + frame.width).toBe(point.x + viewport.width + 128);
  expect(frame.y + frame.height).toBe(point.y + viewport.height + 200);
  expect(cachedViewport(frame, viewport)).toEqual(point);
});

it.each([
  { cachedX: 0, incomingX: 1000, currentX: 0, expected: true },
  { cachedX: 0, incomingX: 1000, currentX: 1000, expected: false },
  { cachedX: 0, incomingX: 1000, currentX: 2000, expected: false },
  { cachedX: 0, incomingX: 100, currentX: 200, expected: false },
])(
  "retains useful cached cells when a distant frame arrives at $currentX",
  ({ cachedX, incomingX, currentX, expected }) => {
    const size = { y: 0, width: 800, height: 800 };
    expect(
      retainCachedViewport(
        { ...size, x: cachedX },
        { ...size, x: incomingX },
        { ...size, x: currentX, width: 400, height: 400 },
      ),
    ).toBe(expected);
  },
);
