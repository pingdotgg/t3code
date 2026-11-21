import { ByteReader, isDigit, workBudget, type Mesh, type MeshLimits } from "./meshParsing.ts";

/**
 * Parses Wavefront OBJ vertex positions (`v`) and faces (`f`); materials, textures and normals are
 * ignored. Polygons are split into fans. A counting pass sizes the arrays exactly. OBJ is Y-up,
 * so points are stored converted to Z-up.
 */

const LINES_PER_SLICE = 200_000;
const V = 0x76;
const F = 0x66;

/** True when the line at the reader is the statement `keyword`, and moves past it. */
function statement(reader: ByteReader, keyword: number) {
  const { bytes, position } = reader;
  const next = bytes[position + 1];
  if (bytes[position] !== keyword || (next !== 0x20 && next !== 0x09)) return false;
  reader.position += 2;
  return true;
}

/** Corners in the face at the reader, which must be just past `f`. */
function countCorners(reader: ByteReader) {
  let corners = 0;
  for (;;) {
    reader.skipSpaces();
    if (reader.atLineEnd()) return corners;
    corners += 1;
    reader.skipToken();
  }
}

/** Returns `null` for data with no faces, or more triangles than `maxTriangles`. */
export async function parseObj(
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  const budget = workBudget(signal, LINES_PER_SLICE);
  const reader = new ByteReader(bytes);

  let vertexCount = 0;
  let triangleCount = 0;
  while (reader.position < reader.end) {
    reader.skipSpaces();
    if (statement(reader, V)) vertexCount += 1;
    else if (statement(reader, F)) triangleCount += Math.max(0, countCorners(reader) - 2);
    reader.nextLine();
    if (budget.spend()) await budget.pause();
  }
  if (triangleCount === 0 || triangleCount > limits.maxTriangles) return null;

  const points = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const corners = new Uint32Array(64);
  let vertices = 0;
  let written = 0;
  reader.position = 0;
  while (reader.position < reader.end) {
    reader.skipSpaces();
    if (statement(reader, V)) {
      reader.skipSpaces();
      const x = reader.number();
      reader.skipSpaces();
      const y = reader.number();
      reader.skipSpaces();
      const z = reader.number();
      points[vertices * 3] = x;
      points[vertices * 3 + 1] = 0 - z;
      points[vertices * 3 + 2] = y;
      vertices += 1;
    } else if (statement(reader, F)) {
      // Corners are `v`, `v/vt`, `v//vn` or `v/vt/vn`; negative indices count back from here.
      let count = 0;
      let valid = true;
      for (;;) {
        reader.skipSpaces();
        if (reader.atLineEnd()) break;
        const negative = reader.bytes[reader.position] === 0x2d;
        if (negative) reader.position += 1;
        let index = 0;
        let digits = 0;
        while (reader.position < reader.end && isDigit(reader.bytes[reader.position]!)) {
          index = index * 10 + (reader.bytes[reader.position]! - 0x30);
          reader.position += 1;
          digits += 1;
        }
        reader.skipToken();
        const resolved = negative ? vertices - index : index - 1;
        if (digits === 0 || resolved < 0 || resolved >= vertices) valid = false;
        if (count < corners.length) corners[count] = resolved;
        count += 1;
      }
      // Fans of more than 64 corners are vanishingly rare; their extra corners are dropped.
      const used = Math.min(count, corners.length);
      for (let corner = 2; corner < used; corner += 1) {
        if (!valid) break;
        indices[written] = corners[0]!;
        indices[written + 1] = corners[corner - 1]!;
        indices[written + 2] = corners[corner]!;
        written += 3;
      }
    }
    reader.nextLine();
    if (budget.spend()) await budget.pause();
  }
  if (written === 0) return null;
  return { points, indices: written === indices.length ? indices : indices.slice(0, written) };
}
