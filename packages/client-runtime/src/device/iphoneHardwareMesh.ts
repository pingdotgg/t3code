import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";
import { iphoneHardwareImage, type iphoneDisplayHardware } from "./iphoneDisplayHardware.ts";

export function createIphoneHardwareMesh(
  hardware: NonNullable<ReturnType<typeof iphoneDisplayHardware>>,
  width: number,
  height: number,
  displayZ: number,
) {
  const texture = new CanvasTexture(iphoneHardwareImage(hardware));
  texture.colorSpace = SRGBColorSpace;
  const geometry = new PlaneGeometry(width, height);
  const material = new MeshBasicMaterial({
    map: texture,
    alphaTest: 0.01,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.position.z = displayZ + 0.0002;
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
