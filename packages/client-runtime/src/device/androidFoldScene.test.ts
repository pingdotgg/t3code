import { PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { createAndroidFoldScene } from "./androidFoldScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

describe("Android fold scene", () => {
  it("maps touches on each open half and the closed cover to the live frame", () => {
    const texture = new Texture();
    const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, 2200, 1840), 180);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const project = (x: number) => {
      const point = new Vector3(x, 0, 0.041).project(camera);
      return scene.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    };
    expect(project(-0.52)?.x).toBeCloseTo(0.25, 1);
    expect(project(0.52)?.x).toBeCloseTo(0.75, 1);
    expect(scene.screenPoint(0.99, 0.5, camera, true)?.x).toBe(1);
    scene.setAngle(0);
    expect(project(0.52)?.x).toBeCloseTo(0.5, 1);
    scene.dispose();
    texture.dispose();
  });
});
