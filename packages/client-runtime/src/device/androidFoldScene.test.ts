import { Box3, Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { createAndroidFoldScene } from "./androidFoldScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

describe("Android fold scene", () => {
  it("moves one physical half around the hinge while preserving both screen halves", () => {
    const texture = new Texture();
    const scene = createAndroidFoldScene(
      texture,
      phoneDisplayLayout({ width: 2200, height: 1840, orientation: "landscape_left" }, 2200, 1840),
      180,
    );
    const moving = scene.orientation.children[0]!;
    const fixed = scene.orientation.children[1]!;
    const openWidth = new Box3().setFromObject(scene.root).getSize(new Vector3()).x;
    const leftScreen = scene.root.getObjectByName("left-inner-screen") as Mesh;
    const rightScreen = scene.root.getObjectByName("right-inner-screen") as Mesh;
    leftScreen.geometry.computeBoundingBox();
    rightScreen.geometry.computeBoundingBox();
    const creaseWidth =
      rightScreen.geometry.boundingBox!.min.x - leftScreen.geometry.boundingBox!.max.x;
    expect(creaseWidth).toBeLessThan(0.01);
    const continuousScreen = scene.root.getObjectByName("continuous-inner-screen") as Mesh;
    const positions = continuousScreen.geometry.getAttribute("position");
    expect(continuousScreen.geometry.index).not.toBeNull();
    expect(Array.from({ length: positions.count }, (_, i) => positions.getX(i))).toContain(0);
    scene.setAngle(90);
    expect(moving.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(fixed.rotation.y).toBe(0);
    scene.setAngle(0);
    const closedWidth = new Box3().setFromObject(scene.root).getSize(new Vector3()).x;
    expect(closedWidth).toBeLessThan(openWidth * 0.7);
    expect(scene.root.getObjectByName("cover-screen")?.visible).toBe(true);
    scene.dispose();
    texture.dispose();
  });

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
