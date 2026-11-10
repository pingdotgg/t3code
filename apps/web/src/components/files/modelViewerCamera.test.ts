import { describe, expect, it } from "vite-plus/test";

import {
  axisView,
  cameraDirection,
  cameraMatrices,
  frameBounds,
  initialCamera,
  meshBounds,
  numpadCommand,
  orbit,
  pan,
  zoom,
  type ModelBounds,
} from "./modelViewerCamera";

const BOUNDS: ModelBounds = { min: [-1, -2, 0], max: [1, 2, 4] };
const NO_CTRL = { ctrl: false };

/** Applies a column-major 4x4 matrix to a point. */
function transform(matrix: Float32Array, [x, y, z]: readonly [number, number, number]) {
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [0, 1, 2].map(
    (row) =>
      (matrix[row]! * x + matrix[row + 4]! * y + matrix[row + 8]! * z + matrix[row + 12]!) / w,
  );
}

describe("modelViewerCamera", () => {
  it("measures mesh bounds", () => {
    expect(meshBounds(Float32Array.of(1, 2, 3, -1, 5, 0, 0, 0, 9))).toEqual({
      min: [-1, 0, 0],
      max: [1, 5, 9],
    });
  });

  it("opens framed on the model from the front right, like the preview image", () => {
    const camera = initialCamera(BOUNDS);
    expect(camera.target).toEqual([0, 0, 2]);
    const direction = cameraDirection(camera);
    expect(direction[0]).toBeGreaterThan(0);
    expect(direction[1]).toBeLessThan(0);
    expect(direction[2]).toBeGreaterThan(0);
    // Every corner lands inside the viewport.
    const { view, projection } = cameraMatrices(camera, 1, BOUNDS);
    for (const x of [-1, 1])
      for (const y of [-2, 2])
        for (const z of [0, 4]) {
          const [sx, sy, sz] = transform(projection, transform(view, [x, y, z]) as never);
          expect(Math.abs(sx!)).toBeLessThan(1);
          expect(Math.abs(sy!)).toBeLessThan(1);
          expect(Math.abs(sz!)).toBeLessThan(1);
        }
  });

  it("fits the model on tall, narrow screens such as phones", () => {
    const aspect = 0.45;
    const { view, projection } = cameraMatrices(initialCamera(BOUNDS, aspect), aspect, BOUNDS);
    for (const x of [-1, 1])
      for (const y of [-2, 2])
        for (const z of [0, 4]) {
          const [sx, sy] = transform(projection, transform(view, [x, y, z]) as never);
          expect(Math.abs(sx!)).toBeLessThan(1);
          expect(Math.abs(sy!)).toBeLessThan(1);
        }
  });

  it("matches Blender's numpad axis views, with Ctrl for the opposite side", () => {
    const camera = initialCamera(BOUNDS);
    const view = (code: string, ctrl = false) =>
      cameraDirection(numpadCommand(camera, code, { ctrl }, BOUNDS)!).map(
        (value) => Math.round(value) + 0,
      );
    expect(view("Numpad1")).toEqual([0, -1, 0]);
    expect(view("Numpad1", true)).toEqual([0, 1, 0]);
    expect(view("Numpad3")).toEqual([1, 0, 0]);
    expect(view("Numpad3", true)).toEqual([-1, 0, 0]);
    expect(view("Numpad7")).toEqual([0, 0, 1]);
    expect(view("Numpad7", true)).toEqual([0, 0, -1]);
    expect(numpadCommand(camera, "KeyA", NO_CTRL, BOUNDS)).toBeNull();
  });

  it("switches axis views to orthographic until the next orbit", () => {
    const front = axisView(initialCamera(BOUNDS), "front");
    expect(front.orthographic).toBe(true);
    expect(orbit(front, 0.1, 0).orthographic).toBe(false);
    const chosen = numpadCommand(initialCamera(BOUNDS), "Numpad5", NO_CTRL, BOUNDS)!;
    expect(chosen.orthographic).toBe(true);
    expect(orbit(axisView(chosen, "top"), 0.1, 0).orthographic).toBe(true);
    const zoomedIn = zoom(front, 0.05, BOUNDS);
    const { view, projection } = cameraMatrices(zoomedIn, 1, BOUNDS);
    for (const x of [BOUNDS.min[0], BOUNDS.max[0]]) {
      for (const y of [BOUNDS.min[1], BOUNDS.max[1]]) {
        for (const z of [BOUNDS.min[2], BOUNDS.max[2]]) {
          const [, , depth] = transform(
            projection,
            transform(view, [x, y, z]) as [number, number, number],
          );
          expect(Math.abs(depth!)).toBeLessThan(1);
        }
      }
    }
  });

  it("keeps the view upright when orbiting past the poles", () => {
    const camera = orbit(initialCamera(BOUNDS), 0, 10);
    expect(camera.pitch).toBeLessThan(Math.PI / 2);
    const { view } = cameraMatrices(camera, 1, BOUNDS);
    expect(view.every(Number.isFinite)).toBe(true);
  });

  it("pans the target with the drag and bounds zoom to the model's scale", () => {
    const front = axisView(initialCamera(BOUNDS), "front");
    const moved = pan(front, 100, 0, 500);
    expect(moved.target[0]).toBeLessThan(front.target[0]);
    expect(moved.target[1]).toBeCloseTo(front.target[1]);
    const close = zoom(front, 1e-12, BOUNDS);
    expect(close.distance).toBeGreaterThan(0);
    expect(frameBounds(close, BOUNDS).distance).toBeCloseTo(front.distance);
  });
});
