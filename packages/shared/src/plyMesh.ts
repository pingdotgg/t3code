import {
  ByteReader,
  GrowableArray,
  workBudget,
  type Mesh,
  type MeshLimits,
} from "./meshParsing.ts";

/**
 * Parses PLY (Stanford polygon) files, ASCII or binary. Vertex positions and face indices are
 * read; colors, normals and other elements are skipped. Polygons are split into fans. The header
 * states the counts, so arrays are sized up front.
 */

const ITEMS_PER_SLICE = 200_000;

type Scalar = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";

const SCALARS: Record<string, { readonly type: Scalar; readonly bytes: number }> = {
  char: { type: "int8", bytes: 1 },
  int8: { type: "int8", bytes: 1 },
  uchar: { type: "uint8", bytes: 1 },
  uint8: { type: "uint8", bytes: 1 },
  short: { type: "int16", bytes: 2 },
  int16: { type: "int16", bytes: 2 },
  ushort: { type: "uint16", bytes: 2 },
  uint16: { type: "uint16", bytes: 2 },
  int: { type: "int32", bytes: 4 },
  int32: { type: "int32", bytes: 4 },
  uint: { type: "uint32", bytes: 4 },
  uint32: { type: "uint32", bytes: 4 },
  float: { type: "float32", bytes: 4 },
  float32: { type: "float32", bytes: 4 },
  double: { type: "float64", bytes: 8 },
  float64: { type: "float64", bytes: 8 },
};

interface Property {
  readonly name: string;
  readonly type: Scalar;
  /** For list properties, the type of the leading count. */
  readonly countType: Scalar | null;
}

interface Element {
  readonly name: string;
  readonly count: number;
  readonly properties: ReadonlyArray<Property>;
}

interface Header {
  readonly format: "ascii" | "binary_little_endian" | "binary_big_endian";
  readonly elements: ReadonlyArray<Element>;
  readonly bodyOffset: number;
}

function parseHeader(bytes: Uint8Array): Header | null {
  const head = new TextDecoder("latin1").decode(
    bytes.subarray(0, Math.min(bytes.length, 64 * 1024)),
  );
  if (!/^ply\r?\n/.test(head)) return null;
  const end = /end_header\r?\n/.exec(head);
  if (!end) return null;
  let format: Header["format"] | null = null;
  const elements: Array<{ name: string; count: number; properties: Property[] }> = [];
  for (const line of head.slice(0, end.index).split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "format") {
      const name = words[1];
      if (name === "ascii" || name === "binary_little_endian" || name === "binary_big_endian") {
        format = name;
      }
    } else if (words[0] === "element") {
      const count = Number(words[2]);
      if (!Number.isSafeInteger(count) || count < 0) return null;
      elements.push({ name: words[1] ?? "", count, properties: [] });
    } else if (words[0] === "property") {
      const element = elements.at(-1);
      const list = words[1] === "list";
      const countType = list ? SCALARS[words[2] ?? ""] : undefined;
      const type = SCALARS[words[list ? 3 : 1] ?? ""];
      if (!element || !type || (list && !countType)) return null;
      element.properties.push({
        name: words[list ? 4 : 2] ?? "",
        type: type.type,
        countType: countType?.type ?? null,
      });
    }
  }
  if (!format) return null;
  return { format, elements, bodyOffset: end.index + end[0].length };
}

// @effect-diagnostics-next-line extendsNativeError:off - the parser is synchronous and Effect-free; TruncatedFile is a local throw sentinel.
class TruncatedFile extends Error {}

/** Returns a function that reads one value of `type` from the body and advances. */
function valueReaders(bytes: Uint8Array, header: Header) {
  if (header.format === "ascii") {
    const reader = new ByteReader(bytes, header.bodyOffset);
    const read = () => {
      reader.skipWhitespace();
      if (reader.position >= reader.end) throw new TruncatedFile();
      return reader.number();
    };
    return (_type: Scalar) => read;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = header.format === "binary_little_endian";
  let offset = header.bodyOffset;
  const take = (size: number) => {
    if (offset + size > view.byteLength) throw new TruncatedFile();
    const at = offset;
    offset += size;
    return at;
  };
  const readers: Record<Scalar, () => number> = {
    int8: () => view.getInt8(take(1)),
    uint8: () => view.getUint8(take(1)),
    int16: () => view.getInt16(take(2), little),
    uint16: () => view.getUint16(take(2), little),
    int32: () => view.getInt32(take(4), little),
    uint32: () => view.getUint32(take(4), little),
    float32: () => view.getFloat32(take(4), little),
    float64: () => view.getFloat64(take(8), little),
  };
  return (type: Scalar) => readers[type];
}

/** Returns `null` for data that is not PLY, has no faces, or exceeds `maxTriangles`. */
export async function parsePly(
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  const header = parseHeader(bytes);
  if (!header) return null;
  // Each item takes at least its fixed-size properties (an ASCII value and its separator take two
  // bytes), so a larger count means a damaged header; reject it before allocating for it.
  const minItemBytes = (element: Element) =>
    element.properties.reduce(
      (sum, property) =>
        sum + (header.format === "ascii" ? 2 : SCALARS[property.countType ?? property.type]!.bytes),
      0,
    );
  const bodyBytes = bytes.length - header.bodyOffset + 1;
  if (header.elements.some((element) => element.count * minItemBytes(element) > bodyBytes)) {
    return null;
  }
  const faces = header.elements.find((element) => element.name === "face");
  if (!faces || faces.count === 0 || faces.count > limits.maxTriangles) return null;
  const readerFor = valueReaders(bytes, header);
  const budget = workBudget(signal, ITEMS_PER_SLICE);
  let points: Float32Array | null = null;
  // Sized for triangles; polygons grow it.
  const indices = new GrowableArray((size) => new Uint32Array(size), faces.count * 3);
  let triangles = 0;

  try {
    for (const element of header.elements) {
      const isVertex = element.name === "vertex";
      const isFace = element === faces;
      const axisOf = element.properties.map((property) =>
        isVertex ? ["x", "y", "z"].indexOf(property.name) : -1,
      );
      if (isVertex) {
        if (!axisOf.includes(0) || !axisOf.includes(1) || !axisOf.includes(2)) return null;
        points = new Float32Array(element.count * 3);
      }
      const reads = element.properties.map((property) => readerFor(property.type));
      const countReads = element.properties.map((property) =>
        property.countType ? readerFor(property.countType) : null,
      );
      const isIndexList = element.properties.map(
        (property) =>
          isFace && (property.name === "vertex_indices" || property.name === "vertex_index"),
      );
      const vertexCount = points ? points.length / 3 : 0;
      for (let item = 0; item < element.count; item += 1) {
        for (let index = 0; index < reads.length; index += 1) {
          const read = reads[index]!;
          const readCount = countReads[index];
          if (!readCount) {
            const value = read();
            const axis = axisOf[index]!;
            if (axis >= 0) points![item * 3 + axis] = value;
            continue;
          }
          const count = readCount();
          if (!isIndexList[index]) {
            for (let entry = 0; entry < count; entry += 1) read();
            continue;
          }
          let first = 0;
          let previous = 0;
          let valid = true;
          for (let entry = 0; entry < count; entry += 1) {
            const corner = read();
            if (!(corner >= 0 && corner < vertexCount)) valid = false;
            if (entry === 0) first = corner;
            else if (entry >= 2 && valid) {
              if ((triangles += 1) > limits.maxTriangles) return null;
              indices.push3(first, previous, corner);
            }
            previous = corner;
          }
        }
        if (budget.spend()) await budget.pause();
      }
    }
  } catch (cause) {
    // A truncated file still shows the faces read before the end.
    if (!(cause instanceof TruncatedFile)) throw cause;
  }
  if (!points || indices.length === 0) return null;
  return {
    points,
    indices: indices.length === indices.data.length ? indices.data : indices.finish(),
  };
}
