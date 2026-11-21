// @effect-diagnostics globalFetch:off - This browser-only renderer owns abortable asset requests without an Effect runtime, like the live stream.
import { Box3, Group, Mesh, MeshBasicMaterial, type Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposeThreeObject } from "../three/disposeObject.ts";
import type { DeviceAssetSource } from "./model.ts";
import { createDisplayProjection, updateDisplayUv, type PhoneDisplayLayout } from "./phoneScene.ts";

export function createImportedPhoneScene(
  asset: Group,
  texture: Texture,
  initial: PhoneDisplayLayout,
) {
  const screens: Mesh[] = [];
  asset.traverse((object) => {
    if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
  });
  const display = screens[0];
  if (!display || screens.length !== 1)
    throw new Error("Device model must have one device-screen mesh");
  asset.updateMatrixWorld(true);
  const screenBounds = new Box3().setFromObject(display);
  const screenWidth = screenBounds.max.x - screenBounds.min.x;
  const screenHeight = screenBounds.max.y - screenBounds.min.y;
  if (
    display.matrixWorld.elements.some(
      (value, index) =>
        !Number.isFinite(value) || Math.abs(value - (index % 5 === 0 ? 1 : 0)) > 0.001,
    ) ||
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    !Number.isFinite(screenBounds.min.z) ||
    !Number.isFinite(screenBounds.max.z) ||
    screenWidth <= 0 ||
    Math.abs(screenHeight - 2.2) > 0.001 ||
    Math.abs(screenBounds.min.x + screenBounds.max.x) > 0.001 ||
    Math.abs(screenBounds.min.y + screenBounds.max.y) > 0.001 ||
    screenBounds.max.z - screenBounds.min.z > 0.001
  )
    throw new Error("Device model display is not normalized");
  updateDisplayUv(display.geometry, screenWidth, screenHeight, initial);
  const originalMaterial = display.material;
  const screenMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  display.material = screenMaterial;
  const root = new Group();
  const orientation = new Group();
  orientation.add(asset);
  root.add(orientation);
  const bounds = new Box3().setFromObject(asset);
  let layout = initial;
  const projection = createDisplayProjection(
    display,
    orientation,
    screenWidth,
    screenHeight,
    () => layout,
  );
  return {
    root,
    orientation,
    width: bounds.max.x - bounds.min.x,
    height: bounds.max.y - bounds.min.y,
    setDisplay(nextTexture: Texture, nextLayout: PhoneDisplayLayout) {
      layout = nextLayout;
      screenMaterial.map = nextTexture;
      updateDisplayUv(display.geometry, screenWidth, screenHeight, layout);
    },
    screenPoint: projection,
    dispose() {
      // The model slot owns imported resources. This scene owns only its replacement screen material.
      display.material = originalMaterial;
      screenMaterial.map = null;
      screenMaterial.dispose();
      orientation.remove(asset);
    },
  };
}

export async function loadDeviceModel(source: DeviceAssetSource, signal: AbortSignal) {
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error(`Device model request failed: ${response.status}`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  const gltf = await new GLTFLoader().parseAsync(
    data,
    new URL(".", new URL(source.url, globalThis.location.href)).href,
  );
  if (signal.aborted) {
    disposeThreeObject(gltf.scene);
    signal.throwIfAborted();
  }
  return { asset: gltf.scene, dispose: () => disposeThreeObject(gltf.scene) };
}
