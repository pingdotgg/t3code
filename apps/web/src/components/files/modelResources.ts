import { Texture } from "three";
import type { BufferGeometry, Material, Object3D, Skeleton } from "three";

function collectModelResources(model: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const skeletons = new Set<Skeleton>();
  model.traverse((child) => {
    const mesh = child as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
      skeleton?: Skeleton;
    };
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.skeleton) skeletons.add(mesh.skeleton);
    for (const material of mesh.material
      ? Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      : [])
      materials.add(material);
  });
  return { geometries, materials, skeletons };
}

/** Shared meshes can reference the same geometry, materials, and textures. */
export function disposeModel(model: Object3D) {
  const { geometries, materials, skeletons } = collectModelResources(model);
  const textures = new Set<Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof Texture) textures.add(value);
    }
  }
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

/** A failed image should leave the material's base color visible. */
export function clearMissingModelTextures(model: Object3D) {
  const { materials } = collectModelResources(model);
  const missing = new Set<Texture>();
  for (const material of materials) {
    for (const [slot, texture] of Object.entries(material)) {
      if (texture instanceof Texture && !texture.image) {
        Reflect.set(material, slot, null);
        material.needsUpdate = true;
        missing.add(texture);
      }
    }
  }
  for (const texture of missing) texture.dispose();
}
