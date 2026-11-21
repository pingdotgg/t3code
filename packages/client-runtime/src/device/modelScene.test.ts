import {
  BoxGeometry,
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
} from "three";
import { expect, it, vi } from "vite-plus/test";
import {
  bakeDisplayTransforms,
  createImportedPhoneScene,
  disposeDeviceModel,
} from "./modelScene.ts";
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

it("accepts a quantized display once loading bakes its node transform", () => {
  const { root, screen } = asset();
  // KHR_mesh_quantization stores normalized shorts and moves their scale and offset onto the node.
  const position = screen.geometry.getAttribute("position");
  const shorts = new Int16Array(position.count * 3);
  for (let i = 0; i < position.count; i++)
    for (let c = 0; c < 3; c++)
      shorts[i * 3 + c] = Math.round(
        ((position.getComponent(i, c) - (c === 2 ? 0.043 : 0)) / 1.1) * 32767,
      );
  screen.geometry.setAttribute("position", new BufferAttribute(shorts, 3, true));
  screen.position.z = 0.043;
  screen.scale.setScalar(1.1);
  bakeDisplayTransforms(root);
  expect(screen.geometry.getAttribute("position").array).toBeInstanceOf(Float32Array);
  const phone = createImportedPhoneScene(root, new Texture(), phoneDisplayLayout(null, 1206, 2622));
  expect(screen.geometry.getAttribute("uv").getX(0)).toBeCloseTo(0, 3);
  phone.dispose();
});
