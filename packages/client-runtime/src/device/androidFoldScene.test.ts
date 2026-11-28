import { type Mesh, type Object3D, PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { createAndroidFoldScene } from "./androidFoldScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

function pictureAspect(object: Object3D | undefined) {
  const { geometry } = object as Mesh;
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const span = (read: (index: number) => number) => {
    const values = Array.from({ length: position.count }, (_, index) => read(index));
    return Math.max(...values) - Math.min(...values);
  };
  const width = span((i) => position.getX(i)) / span((i) => uv.getX(i));
  const height = span((i) => position.getY(i)) / span((i) => uv.getY(i));
  return width / height;
}

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

  it("treats the bars beside a letterboxed phone frame as bezel", () => {
    const texture = new Texture();
    const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, 1080, 2400), 180);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const point = (x: number) => {
      const projected = new Vector3(x, 0, 0.041).project(camera);
      return [(projected.x + 1) / 2, (1 - projected.y) / 2] as const;
    };
    expect(scene.screenPoint(...point(0.4), camera)?.x).toBeCloseTo(0.914, 2);
    expect(scene.screenPoint(...point(0.7), camera)).toBeNull();
    expect(scene.screenPoint(...point(0.7), camera, true)?.x).toBe(1);
    scene.dispose();
    texture.dispose();
  });

  it.each([
    { name: "a phone frame", width: 1080, height: 2400 },
    { name: "a tablet frame", width: 1920, height: 1200 },
  ])("draws $name at its own aspect after a fold-sized frame", ({ width, height }) => {
    const texture = new Texture();
    const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, 2208, 1840), 180);
    scene.setDisplay(texture, phoneDisplayLayout(null, width, height));
    const inner = scene.root.getObjectByName("continuous-inner-screen");
    expect(pictureAspect(inner), "open inner screen").toBeCloseTo(width / height, 2);
    scene.setAngle(0);
    const cover = scene.root.getObjectByName("cover-screen");
    expect(pictureAspect(cover), "closed cover screen").toBeCloseTo(width / height, 2);
    scene.dispose();
    texture.dispose();
  });
});
