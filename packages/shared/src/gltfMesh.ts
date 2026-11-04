import { workBudget, type Mesh, type MeshLimits } from "./meshParsing.ts";

/**
 * Parses glTF 2.0 (`.glb` or `.gltf`) into a Z-up mesh with node transforms applied. Buffers must
 * be inside the file (GLB chunk or `data:` URI); external `.bin` files and Draco or meshopt
 * compression are unsupported. Arrays are sized from accessor counts before any data is read.
 */

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const ITEMS_PER_SLICE = 500_000;
const MAX_NODE_VISITS = 100_000;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

/** Column-major 4x4 matrix. */
type Matrix = readonly number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface Accessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly normalized?: boolean;
  readonly count: number;
  readonly type: string;
}

interface GltfNode {
  readonly mesh?: number;
  readonly children?: ReadonlyArray<number>;
  readonly matrix?: ReadonlyArray<number>;
  readonly translation?: ReadonlyArray<number>;
  readonly rotation?: ReadonlyArray<number>;
  readonly scale?: ReadonlyArray<number>;
}

interface Document {
  readonly scene?: number;
  readonly scenes?: ReadonlyArray<{ readonly nodes?: ReadonlyArray<number> }>;
  readonly nodes?: ReadonlyArray<GltfNode>;
  readonly meshes?: ReadonlyArray<{
    readonly primitives?: ReadonlyArray<{
      readonly attributes?: { readonly POSITION?: number };
      readonly indices?: number;
      readonly mode?: number;
    }>;
  }>;
  readonly accessors?: ReadonlyArray<Accessor>;
  readonly bufferViews?: ReadonlyArray<{
    readonly buffer: number;
    readonly byteOffset?: number;
    readonly byteLength: number;
    readonly byteStride?: number;
    readonly extensions?: Record<string, unknown>;
  }>;
  readonly buffers?: ReadonlyArray<{ readonly uri?: string; readonly byteLength: number }>;
}

function readGlb(bytes: Uint8Array): { json: string; binary: Uint8Array | null } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== GLB_MAGIC) return null;
  if (view.getUint32(4, true) !== 2) return null;
  let json: string | null = null;
  let binary: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (type === JSON_CHUNK && json === null) json = new TextDecoder().decode(chunk);
    if (type === BINARY_CHUNK && binary === null) binary = chunk;
    at += 8 + length;
  }
  return json === null ? null : { json, binary };
}

function decodeDataUri(uri: string): Uint8Array | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!match) return null;
  try {
    const binary = atob(match[1]!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const result: number[] = [];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) value += a[k * 4 + row]! * b[column * 4 + k]!;
      result.push(value);
    }
  }
  return result;
}

function localMatrix(node: GltfNode): Matrix {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // prettier-ignore
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

/** Where an accessor's values live, read in place from the file's buffer. */
interface AccessorData {
  readonly start: number;
  readonly stride: number;
  readonly count: number;
  readonly components: number;
  readonly componentBytes: number;
  readonly read: (at: number) => number;
}

/** A primitive to draw with its world transform, resolved before any arrays are allocated. */
interface Draw {
  readonly positions: AccessorData;
  readonly indices: AccessorData | null;
  readonly mode: number;
  readonly world: Matrix;
  readonly triangles: number;
}

function componentReader(view: DataView, type: number, normalized: boolean) {
  switch (type) {
    case 5120:
      return normalized
        ? (at: number) => Math.max(view.getInt8(at) / 127, -1)
        : (at: number) => view.getInt8(at);
    case 5121:
      return normalized
        ? (at: number) => view.getUint8(at) / 255
        : (at: number) => view.getUint8(at);
    case 5122:
      return normalized
        ? (at: number) => Math.max(view.getInt16(at, true) / 32767, -1)
        : (at: number) => view.getInt16(at, true);
    case 5123:
      return normalized
        ? (at: number) => view.getUint16(at, true) / 65535
        : (at: number) => view.getUint16(at, true);
    case 5125:
      return (at: number) => view.getUint32(at, true);
    default:
      return (at: number) => view.getFloat32(at, true);
  }
}

/** Returns `null` for data that is not glTF, has no drawable triangles, or exceeds `maxTriangles`. */
export async function parseGltf(
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  const glb = readGlb(bytes);
  let document: Document;
  try {
    document = JSON.parse(glb ? glb.json : new TextDecoder().decode(bytes)) as Document;
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;

  const buffers = (document.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) return index === 0 ? (glb?.binary ?? null) : null;
    return decodeDataUri(buffer.uri);
  });

  /** `null` when the accessor's data is missing, out of range, or compressed. */
  const accessorData = (index: number | undefined): AccessorData | null => {
    const accessor = index === undefined ? undefined : document.accessors?.[index];
    if (!accessor || accessor.bufferView === undefined) return null;
    const bufferView = document.bufferViews?.[accessor.bufferView];
    const buffer = bufferView ? buffers[bufferView.buffer] : null;
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    const components = TYPE_COMPONENTS[accessor.type];
    if (!bufferView || !buffer || !componentBytes || !components) return null;
    if (bufferView.extensions && Object.keys(bufferView.extensions).length > 0) return null;
    const stride = bufferView.byteStride ?? componentBytes * components;
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const end = start + (accessor.count - 1) * stride + componentBytes * components;
    if (accessor.count <= 0 || end > buffer.length) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const read = componentReader(view, accessor.componentType, accessor.normalized === true);
    return { start, stride, count: accessor.count, components, componentBytes, read };
  };

  const draws: Draw[] = [];
  const addMesh = (meshIndex: number, world: Matrix) => {
    for (const primitive of document.meshes?.[meshIndex]?.primitives ?? []) {
      const mode = primitive.mode ?? TRIANGLES;
      if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) continue;
      const positions = accessorData(primitive.attributes?.POSITION);
      if (!positions || positions.components !== 3) continue;
      const indices = primitive.indices === undefined ? null : accessorData(primitive.indices);
      if (primitive.indices !== undefined && !indices) continue;
      const corners = indices ? indices.count : positions.count;
      const triangles = mode === TRIANGLES ? Math.floor(corners / 3) : Math.max(0, corners - 2);
      if (triangles > 0) draws.push({ positions, indices, mode, world, triangles });
    }
  };

  const nodes = document.nodes ?? [];
  const sceneRoots = document.scenes?.[document.scene ?? 0]?.nodes;
  if (sceneRoots || nodes.length > 0) {
    const children = new Set(nodes.flatMap((node) => node.children ?? []));
    const roots =
      sceneRoots ?? nodes.map((_, index) => index).filter((index) => !children.has(index));
    let visits = 0;
    const visit = (index: number, parent: Matrix, path: ReadonlySet<number>) => {
      const node = nodes[index];
      // A node listed in its own ancestry would loop forever; malformed files can do that.
      if (!node || path.has(index) || (visits += 1) > MAX_NODE_VISITS) return;
      const world = multiply(parent, localMatrix(node));
      if (node.mesh !== undefined) addMesh(node.mesh, world);
      const nextPath = new Set(path).add(index);
      for (const child of node.children ?? []) visit(child, world, nextPath);
    };
    for (const root of roots) visit(root, IDENTITY, new Set());
  } else {
    // No nodes: draw each mesh once where it was modeled.
    for (let mesh = 0; mesh < (document.meshes?.length ?? 0); mesh += 1) addMesh(mesh, IDENTITY);
  }

  // Size the result exactly before reading anything, and refuse oversized files up front.
  const totalTriangles = draws.reduce((sum, draw) => sum + draw.triangles, 0);
  if (totalTriangles === 0 || totalTriangles > limits.maxTriangles) return null;
  const totalPoints = draws.reduce((sum, draw) => sum + draw.positions.count, 0);
  const points = new Float32Array(totalPoints * 3);
  const indices = new Uint32Array(totalTriangles * 3);
  const budget = workBudget(signal, ITEMS_PER_SLICE);
  let pointBase = 0;
  let written = 0;
  for (const { positions, indices: source, mode, world, triangles } of draws) {
    const { start, stride, read, componentBytes } = positions;
    for (let point = 0; point < positions.count; point += 1) {
      const at = start + point * stride;
      const x = read(at);
      const y = read(at + componentBytes);
      const z = read(at + componentBytes * 2);
      const out = (pointBase + point) * 3;
      // Transform, then convert glTF's Y-up to Z-up: (x, y, z) becomes (x, -z, y).
      points[out] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
      points[out + 1] = 0 - (world[2]! * x + world[6]! * y + world[10]! * z + world[14]!);
      points[out + 2] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
      if (budget.spend()) await budget.pause();
    }
    const corner = source
      ? (index: number) => source.read(source.start + index * source.stride)
      : (index: number) => index;
    const count = positions.count;
    const add = (a: number, b: number, c: number) => {
      if (a >= count || b >= count || c >= count) return;
      indices[written] = pointBase + a;
      indices[written + 1] = pointBase + b;
      indices[written + 2] = pointBase + c;
      written += 3;
    };
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      if (mode === TRIANGLES) {
        add(corner(triangle * 3), corner(triangle * 3 + 1), corner(triangle * 3 + 2));
      } else if (mode === TRIANGLE_FAN) {
        add(corner(0), corner(triangle + 1), corner(triangle + 2));
      } else if (triangle % 2 === 0) {
        add(corner(triangle), corner(triangle + 1), corner(triangle + 2));
      } else {
        // Alternate the winding so every strip triangle faces the same way.
        add(corner(triangle + 1), corner(triangle), corner(triangle + 2));
      }
      if (budget.spend()) await budget.pause();
    }
    pointBase += count;
  }
  if (written === 0) return null;
  return { points, indices: written === indices.length ? indices : indices.slice(0, written) };
}
