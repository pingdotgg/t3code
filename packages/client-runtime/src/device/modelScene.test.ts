import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
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
