import { ByteReader, workBudget, type Mesh, type MeshLimits } from "./meshParsing.ts";

/**
 * Parses binary and ASCII STL. STL lists every triangle's corners, so the mesh is unindexed.
 * Stored normals are ignored because exporters often leave them zero; renderers derive their own.
 */

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;
const VERTEX = "vertex";
const TRIANGLES_PER_SLICE = 200_000;

function binaryTriangleCount(bytes: Uint8Array) {
  if (bytes.length < BINARY_HEADER_BYTES) return null;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  // Some exporters append a few bytes; never read past the end.
  return BINARY_HEADER_BYTES + count * BINARY_TRIANGLE_BYTES <= bytes.length ? count : null;
}

function startsWithSolid(bytes: Uint8Array) {
  const reader = new ByteReader(bytes);
  reader.skipWhitespace();
  return reader.consume("solid") || reader.consume("SOLID");
}

/** Positions of each `vertex` keyword that starts a word, found without decoding the text. */
function* vertexKeywords(bytes: Uint8Array) {
  const first = VERTEX.charCodeAt(0);
  for (let at = bytes.indexOf(first); at >= 0; at = bytes.indexOf(first, at + 1)) {
    if (at > 0 && bytes[at - 1]! > 0x20) continue;
    let matches = true;
    for (let index = 1; index < VERTEX.length && matches; index += 1) {
      matches = bytes[at + index] === VERTEX.charCodeAt(index);
    }
    if (matches) yield at + VERTEX.length;
  }
}

/** Returns `null` for data that is not STL, has no triangles, or exceeds `maxTriangles`. */
export async function parseStl(
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  const budget = workBudget(signal, TRIANGLES_PER_SLICE);
  const binaryCount = binaryTriangleCount(bytes);
  // Binary files may also start with "solid"; a matching triangle count decides.
  if (binaryCount !== null && (binaryCount > 0 || !startsWithSolid(bytes))) {
    if (binaryCount === 0 || binaryCount > limits.maxTriangles) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = new Float32Array(binaryCount * 9);
    for (let triangle = 0; triangle < binaryCount; triangle += 1) {
      if (budget.spend()) await budget.pause();
      // Skip the 12-byte normal; then three vertices of three little-endian floats.
      const start = BINARY_HEADER_BYTES + triangle * BINARY_TRIANGLE_BYTES + 12;
      for (let value = 0; value < 9; value += 1) {
        points[triangle * 9 + value] = view.getFloat32(start + value * 4, true);
      }
    }
    return { points, indices: null };
  }
  if (!startsWithSolid(bytes)) return null;

  // Count first so the result is allocated once at its final size.
  let vertices = 0;
  for (const _ of vertexKeywords(bytes)) {
    vertices += 1;
    if (budget.spend()) await budget.pause();
  }
  const triangles = Math.floor(vertices / 3);
  if (triangles === 0 || triangles > limits.maxTriangles) return null;
  const points = new Float32Array(triangles * 9);
  const reader = new ByteReader(bytes);
  let written = 0;
  for (const at of vertexKeywords(bytes)) {
    if (written === points.length) break;
    reader.position = at;
    for (let axis = 0; axis < 3; axis += 1) {
      reader.skipSpaces();
      points[written + axis] = reader.number();
    }
    written += 3;
    if (budget.spend()) await budget.pause();
  }
  return { points, indices: null };
}
