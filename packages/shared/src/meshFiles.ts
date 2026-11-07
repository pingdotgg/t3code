import type { MeshFormat } from "./filePreview.ts";
import type { Mesh, MeshLimits } from "./meshParsing.ts";
import { parseGltf } from "./gltfMesh.ts";
import { parseObj } from "./objMesh.ts";
import { parsePly } from "./plyMesh.ts";
import { parseStl } from "./stlMesh.ts";
import { parseThreeMf } from "./threeMfMesh.ts";

export { triangleCount, type Mesh } from "./meshParsing.ts";

/** The most triangles the 3D view draws. */
export const MODEL_VIEWER_MAX_TRIANGLES = 2_000_000;

/**
 * Reads any supported mesh file into indexed Z-up geometry. The server renders preview images from
 * it and clients draw it in the 3D view, so a new format needs only a parser here and an extension
 * in `modelPreviewFormat`.
 */
export function parseMesh(
  format: MeshFormat,
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  switch (format) {
    case "stl":
      return parseStl(bytes, limits, signal);
    case "obj":
      return parseObj(bytes, limits, signal);
    case "ply":
      return parsePly(bytes, limits, signal);
    case "3mf":
      return parseThreeMf(bytes, limits, signal);
    case "gltf":
      return parseGltf(bytes, limits, signal);
  }
}
