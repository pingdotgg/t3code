import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
  Vector3,
} from "three";
import { expect, it } from "vite-plus/test";
import { createDuoScene, duoDisplayKey, duoRawPoint } from "./duoScene.ts";

function fixture() {
  const asset = new Group();
  const left = new Group();
  left.name = "left-half";
  const right = new Group();
  right.name = "right-half";
  const screen = (name: string, x: number, z: number, rear = false) => {
    const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
    if (rear) mesh.geometry.rotateY(Math.PI);
    mesh.geometry.translate(x, 0, z);
    mesh.name = name;
    return mesh;
  };
  const innerLeft = screen("inner-display-left", -0.5, 0.06);
  const innerRight = screen("inner-display-right", 0.5, 0.06);
  const cover = screen("cover-display", -0.5, -0.06, true);
  left.add(innerLeft, cover);
  right.add(innerRight);
  for (const [group, x] of [
    [left, -0.5],
    [right, 0.5],
  ] as const) {
    const body = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshBasicMaterial());
    body.geometry.translate(x, 0, 0);
    group.add(body);
  }
  asset.add(left, right);
  const scene = createDuoScene(asset, { 1: new Texture(), 3: new Texture() });
  const camera = new PerspectiveCamera(36, 1, 0.1, 50);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  return { scene, camera, left, right, innerLeft, innerRight };
}

it("keeps one continuous inner UV map across the hinge and folds opposite leaves", () => {
  const { scene, left, right, innerLeft, innerRight } = fixture();
  scene.setAngle(90);
  expect(left.rotation.y).toBeCloseTo(Math.PI / 4);
  expect(right.rotation.y).toBeCloseTo(-Math.PI / 4);
  const values = (mesh: Mesh) =>
    Array.from({ length: mesh.geometry.getAttribute("uv").count }, (_, i) =>
      mesh.geometry.getAttribute("uv").getX(i),
    );
  expect(Math.max(...values(innerLeft))).toBe(0.5);
  expect(Math.min(...values(innerRight))).toBe(0.5);
  scene.dispose();
});

it("maps active display input through hardware mounting and blocks rear, inactive and stale surfaces", () => {
  const { scene, camera, innerLeft } = fixture();
  scene.setAngle(180);
  const screen = { width: 2007, height: 2853, orientation: "portrait" as const, screenId: 3 };
  const key = duoDisplayKey(screen);
  scene.root.updateMatrixWorld();
  const world = innerLeft.localToWorld(new Vector3(-0.5, -0.5, 0.06)).project(camera);
  const x = (world.x + 1) / 2,
    y = (1 - world.y) / 2;
  const hit = scene.screenPoint(x, y, camera, screen, key);
  expect(hit?.x).toBeCloseTo(0.75);
  expect(hit?.y).toBeCloseTo(0.75);
  expect(
    scene.screenPoint(
      x,
      y,
      camera,
      { ...screen, screenId: 1 },
      duoDisplayKey({ ...screen, screenId: 1 }),
    ),
  ).toBeNull();
  expect(scene.screenPoint(x, y, camera, screen, "old")).toBeNull();
  expect(scene.screenPoint(x, y, camera, screen, key)).not.toBeNull();
  expect(scene.screenPoint(x, 1.1, camera, screen, key, true)?.x).toBeGreaterThan(1);
  expect(duoRawPoint(1, 0.2, 0.7)).toEqual({ x: 0.2, y: 0.7 });
  scene.dispose();
});
