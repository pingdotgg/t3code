import { Box3, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";

import { fitModelCamera } from "./modelCamera";

describe("model camera framing", () => {
  it.each(
    (
      [
        [300, 900],
        [1200, 250],
        [600, 600],
      ] as const
    ).flatMap(([width, height]) =>
      (
        [
          ["tall tree", new Vector3(3, 20, 3)],
          ["wide car", new Vector3(12, 2, 4)],
          ["tiny model", new Vector3(0.001, 0.002, 0.001)],
        ] as const
      ).map(([name, size]) => ({ width, height, name, size })),
    ),
  )("centers and contains an offset $name in $width x $height", ({ width, height, size }) => {
    const bounds = new Box3().setFromCenterAndSize(new Vector3(10, -7, 30), size);
    const camera = new PerspectiveCamera(45);
    fitModelCamera(camera, bounds, width, height);
    const center = bounds.getCenter(new Vector3()).project(camera);
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0);
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = new Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.850001);
          expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.850001);
          expect(projected.z).toBeGreaterThan(-1);
          expect(projected.z).toBeLessThan(1);
        }
      }
    }
  });

  it("waits for a visible viewport and then refits after resizing", () => {
    const camera = new PerspectiveCamera(45);
    const bounds = new Box3().setFromCenterAndSize(new Vector3(), new Vector3(10, 2, 3));
    const initial = camera.position.clone();
    fitModelCamera(camera, bounds, 0, 500);
    expect(camera.position).toEqual(initial);
    fitModelCamera(camera, bounds, 1000, 500);
    const wideDistance = camera.position.length();
    fitModelCamera(camera, bounds, 200, 500);
    expect(camera.position.length()).toBeGreaterThan(wideDistance);
  });

  it("keeps the model inside the clipping planes after zooming out", () => {
    const camera = new PerspectiveCamera(45);
    const bounds = new Box3().setFromCenterAndSize(new Vector3(), new Vector3(10, 2, 3));
    fitModelCamera(camera, bounds, 400, 700);
    camera.position.multiplyScalar(5);
    camera.updateMatrixWorld();
    const center = bounds.getCenter(new Vector3()).project(camera);
    expect(center.z).toBeGreaterThan(-1);
    expect(center.z).toBeLessThan(1);
  });
});
