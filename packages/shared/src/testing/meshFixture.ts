import type { Mesh } from "../meshParsing.ts";

/** Expands a mesh to nine coordinates per triangle, so tests can compare plain lists. */
export function expandMesh(mesh: Mesh | null): Float32Array | null {
  if (!mesh) return null;
  if (!mesh.indices) return mesh.points;
  const expanded = new Float32Array(mesh.indices.length * 3);
  mesh.indices.forEach((vertex, corner) => {
    expanded.set(mesh.points.subarray(vertex * 3, vertex * 3 + 3), corner * 3);
  });
  return expanded;
}
