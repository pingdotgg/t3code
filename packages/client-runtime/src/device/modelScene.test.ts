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
import { expect, it, vi } from "vite-plus/test";
import { createImportedPhoneScene, disposeDeviceModel } from "./modelScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

function asset() {
  const root = new Group();
  const body = new Mesh(new BoxGeometry(1.15, 2.3, 0.1), new MeshBasicMaterial());
  body.position.z = -0.02;
  const screen = new Mesh(new PlaneGeometry(1, 2.2), new MeshBasicMaterial());
  screen.geometry.translate(0, 0, 0.043);
  screen.name = "device-screen";
  root.add(body, screen);
  return { root, screen, body };
}

it.each(["portrait", "landscape_left", "landscape_right", "portrait_upside_down"] as const)(
  "retains the imported geometry while mapping screen input and framebuffer UVs in %s",
  (orientation) => {
    const { root, screen } = asset();
    const texture = new Texture();
    const original = screen.material;
    // Optimization strips UVs from the placeholder material; the viewer generates framebuffer UVs.
    screen.geometry.deleteAttribute("uv");
    const phone = createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622));
    const layout = phoneDisplayLayout({ width: 1206, height: 2622, orientation }, 1206, 2622);
    phone.setDisplay(texture, layout);
    phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
    phone.orientation.rotation.z = layout.rotation;
    phone.root.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const point = phone.orientation.localToWorld(new Vector3(-0.25, -0.55, 0.043)).project(camera);
    const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    const expected =
      orientation === "landscape_left"
        ? [0.25, 0.25]
        : orientation === "landscape_right"
          ? [0.75, 0.75]
          : orientation === "portrait_upside_down"
            ? [0.75, 0.25]
            : [0.25, 0.75];
    expect(hit?.x).toBeCloseTo(expected[0]!);
    expect(hit?.y).toBeCloseTo(expected[1]!);
    const geometry = screen.geometry;
    const rotated = phoneDisplayLayout(
      { width: 2622, height: 1206, orientation: "landscape_left" },
      2622,
      1206,
    );
    phone.setDisplay(texture, rotated);
    expect(screen.geometry).toBe(geometry);
    const pos = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(pos.getY(i) / 2.2 + 0.5);
      expect(uv.getY(i)).toBeCloseTo(0.5 - pos.getX(i));
    }
    phone.dispose();
    expect(screen.material).toBe(original);
    disposeDeviceModel(root);
    texture.dispose();
  },
);

it("rejects touches from the rear and preserves borrowed textures when releasing imported resources", () => {
  const { root, screen, body } = asset();
  const texture = new Texture();
  const borrowed = vi.spyOn(texture, "dispose");
  const ownedTexture = new Texture();
  const owned = vi.spyOn(ownedTexture, "dispose");
  body.material.map = ownedTexture;
  const geometry = vi.spyOn(body.geometry, "dispose");
  const phone = createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622));
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  phone.root.rotation.y = Math.PI;
  expect(phone.screenPoint(0.5, 0.5, camera)).toBeNull();
  phone.dispose();
  expect(borrowed).not.toHaveBeenCalled();
  expect(geometry).not.toHaveBeenCalled();
  expect(screen.material.map).toBeNull();
  disposeDeviceModel(root);
  expect(owned).toHaveBeenCalledOnce();
  expect(geometry).toHaveBeenCalledOnce();
  expect(borrowed).not.toHaveBeenCalled();
  texture.dispose();
});

it("rejects missing and incorrectly normalized displays before changing their materials", () => {
  const { root, screen } = asset();
  const original = screen.material;
  const texture = new Texture();
  screen.geometry.scale(1, 2, 1);
  expect(() =>
    createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
  ).toThrow("not normalized");
  expect(screen.material).toBe(original);
  screen.geometry.scale(1, 0.5, 1);
  root.rotation.y = Math.PI;
  expect(() =>
    createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
  ).toThrow("not normalized");
  expect(screen.material).toBe(original);
  screen.name = "wrong-screen";
  expect(() =>
    createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
  ).toThrow("one device-screen");
  disposeDeviceModel(root);
  texture.dispose();
});
