import {
  ByteReader,
  GrowableArray,
  workBudget,
  type Mesh,
  type MeshLimits,
} from "./meshParsing.ts";
import { readZipEntry, streamZipEntry, zipEntries, type ZipEntry } from "./zipEntries.ts";

/**
 * Parses 3MF packages: ZIPs of XML model parts. Each part is inflated and scanned tag by tag as it
 * streams, reading numbers straight from bytes, so the XML is never held whole. Build items place
 * objects; objects hold a mesh or components referencing other objects, possibly in other parts.
 * Colors, materials and other extensions are ignored. 3MF is Z-up.
 */

/** Total XML to scan; bounds the time a hostile package can take. */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;
/** A single tag longer than this means the data is not a model. */
const MAX_TAG_BYTES = 1024 * 1024;
const MAX_COMPONENT_DEPTH = 16;
const MAX_PLACEMENT_VISITS = 100_000;
const TAGS_PER_SLICE = 200_000;
const DEFAULT_MODEL_PATH = "3D/3dmodel.model";
const MODEL_RELATIONSHIP = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

/** Row-vector affine transform: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32. */
type Transform = readonly number[];
const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface Reference {
  readonly objectId: string;
  /** The model part holding the object, when it is not the referencing part. */
  readonly path: string | null;
  readonly transform: Transform;
}

interface ModelObject {
  points: Float32Array;
  indices: Uint32Array;
  readonly components: Reference[];
}

interface ModelPart {
  readonly objects: Map<string, ModelObject>;
  readonly build: Reference[];
}

// @effect-diagnostics-next-line extendsNativeError:off - the parser is synchronous and Effect-free; TooLarge is a local throw sentinel.
class TooLarge extends Error {}

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const COLON = 0x3a;
const EQUALS = 0x3d;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();

/** True when `bytes[from, to)` spells `word`. */
function spells(bytes: Uint8Array, from: number, to: number, word: string) {
  if (to - from !== word.length) return false;
  for (let index = 0; index < word.length; index += 1) {
    if (bytes[from + index] !== word.charCodeAt(index)) return false;
  }
  return true;
}

/** Calls `visit` for each `name="value"` between `from` and `to`, with namespace prefixes removed. */
function forEachAttribute(
  bytes: Uint8Array,
  from: number,
  to: number,
  visit: (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number) => void,
) {
  let at = from;
  while (at < to) {
    while (at < to && (bytes[at]! <= 0x20 || bytes[at] === SLASH)) at += 1;
    let nameStart = at;
    while (at < to && bytes[at] !== EQUALS && bytes[at]! > 0x20) {
      if (bytes[at] === COLON) nameStart = at + 1;
      at += 1;
    }
    const nameEnd = at;
    while (at < to && bytes[at]! <= 0x20) at += 1;
    if (bytes[at] !== EQUALS) return;
    at += 1;
    while (at < to && bytes[at]! <= 0x20) at += 1;
    const quote = bytes[at];
    if (quote !== 0x22 && quote !== 0x27) return;
    const valueEnd = bytes.indexOf(quote, at + 1);
    if (valueEnd < 0 || valueEnd > to) return;
    visit(nameStart, nameEnd, at + 1, valueEnd);
    at = valueEnd + 1;
  }
}

function stringAttributes(bytes: Uint8Array, from: number, to: number) {
  const values = new Map<string, string>();
  forEachAttribute(bytes, from, to, (nameStart, nameEnd, valueStart, valueEnd) => {
    values.set(
      latin1.decode(bytes.subarray(nameStart, nameEnd)),
      utf8.decode(bytes.subarray(valueStart, valueEnd)),
    );
  });
  return values;
}

function parseTransform(value: string | undefined): Transform {
  const numbers = value?.trim().split(/\s+/).map(Number);
  return numbers?.length === 12 && numbers.every(Number.isFinite) ? numbers : IDENTITY;
}

function reference(values: Map<string, string>): Reference | null {
  const objectId = values.get("objectid");
  if (!objectId) return null;
  const path = values.get("path");
  return {
    objectId,
    path: path ? path.replace(/^\//, "") : null,
    transform: parseTransform(values.get("transform")),
  };
}

/** Applies `inner`, then `outer`. */
function compose(inner: Transform, outer: Transform): Transform {
  const result: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let value = row === 3 ? outer[9 + column]! : 0;
      for (let k = 0; k < 3; k += 1) value += inner[row * 3 + k]! * outer[k * 3 + column]!;
      result.push(value);
    }
  }
  return result;
}

/** Streams one model part, collecting its objects and build items. */
async function parsePart(
  bytes: Uint8Array,
  entry: ZipEntry,
  budget: ReturnType<typeof workBudget>,
  inflateLimit: number,
  triangleBudget: { remaining: number },
): Promise<{ part: ModelPart; inflated: number } | null> {
  const part: ModelPart = { objects: new Map(), build: [] };
  const numbers = new ByteReader(bytes);
  let current: {
    id: string;
    points: GrowableArray<Float32Array>;
    indices: GrowableArray<Uint32Array>;
    components: Reference[];
  } | null = null;
  let inBuild = false;
  const vertex = [0, 0, 0];

  const finishObject = () => {
    if (!current) return;
    part.objects.set(current.id, {
      points: current.points.finish(),
      indices: current.indices.finish(),
      components: current.components,
    });
    current = null;
  };

  /** Handles the tag between `<` and `>`, exclusive. */
  const onTag = (buffer: Uint8Array, start: number, end: number) => {
    const closing = buffer[start] === SLASH;
    let nameStart = closing ? start + 1 : start;
    let at = nameStart;
    while (at < end && buffer[at]! > 0x20 && buffer[at] !== SLASH) {
      if (buffer[at] === COLON) nameStart = at + 1;
      at += 1;
    }
    const nameEnd = at;
    const selfClosing = buffer[end - 1] === SLASH;
    if (spells(buffer, nameStart, nameEnd, "vertex")) {
      if (!current) return;
      vertex[0] = vertex[1] = vertex[2] = Number.NaN;
      forEachAttribute(buffer, nameEnd, end, (keyStart, keyEnd, valueStart, valueEnd) => {
        const axis = keyEnd - keyStart === 1 ? buffer[keyStart]! - 0x78 : -1;
        if (axis < 0 || axis > 2) return;
        numbers.bytes = buffer;
        numbers.position = valueStart;
        numbers.end = valueEnd;
        vertex[axis] = numbers.number();
      });
      current.points.push3(vertex[0]!, vertex[1]!, vertex[2]!);
    } else if (spells(buffer, nameStart, nameEnd, "triangle")) {
      if (!current) return;
      vertex[0] = vertex[1] = vertex[2] = -1;
      forEachAttribute(buffer, nameEnd, end, (keyStart, keyEnd, valueStart, valueEnd) => {
        if (keyEnd - keyStart !== 2 || buffer[keyStart] !== 0x76) return;
        const corner = buffer[keyStart + 1]! - 0x31;
        if (corner < 0 || corner > 2) return;
        numbers.bytes = buffer;
        numbers.position = valueStart;
        numbers.end = valueEnd;
        vertex[corner] = numbers.number();
      });
      if ((triangleBudget.remaining -= 1) < 0) throw new TooLarge();
      current.indices.push3(vertex[0]!, vertex[1]!, vertex[2]!);
    } else if (spells(buffer, nameStart, nameEnd, "object")) {
      if (closing) return finishObject();
      finishObject();
      const id = stringAttributes(buffer, nameEnd, end).get("id");
      if (!id) return;
      current = {
        id,
        points: new GrowableArray((size) => new Float32Array(size)),
        indices: new GrowableArray((size) => new Uint32Array(size)),
        components: [],
      };
      if (selfClosing) finishObject();
    } else if (spells(buffer, nameStart, nameEnd, "component")) {
      const found = current ? reference(stringAttributes(buffer, nameEnd, end)) : null;
      if (found) current!.components.push(found);
    } else if (spells(buffer, nameStart, nameEnd, "build")) {
      inBuild = !closing && !selfClosing;
    } else if (inBuild && spells(buffer, nameStart, nameEnd, "item")) {
      const found = reference(stringAttributes(buffer, nameEnd, end));
      if (found) part.build.push(found);
    }
  };

  // Tags can span chunks; carry the unfinished end of each chunk into the next.
  let carry = new Uint8Array(0);
  let inflated = 0;
  const complete = await streamZipEntry(bytes, entry, inflateLimit, async (chunk) => {
    inflated += chunk.length;
    let buffer = chunk;
    if (carry.length > 0) {
      buffer = new Uint8Array(carry.length + chunk.length);
      buffer.set(carry);
      buffer.set(chunk, carry.length);
    }
    let at = 0;
    for (;;) {
      const open = buffer.indexOf(LESS_THAN, at);
      if (open < 0) {
        carry = new Uint8Array(0);
        break;
      }
      const close = buffer.indexOf(GREATER_THAN, open + 1);
      if (close < 0) {
        if (buffer.length - open > MAX_TAG_BYTES) throw new TooLarge();
        carry = buffer.slice(open);
        break;
      }
      onTag(buffer, open + 1, close);
      at = close + 1;
      if (budget.spend()) await budget.pause();
    }
  });
  if (!complete) return null;
  finishObject();
  return { part, inflated };
}

async function rootModelPath(bytes: Uint8Array, entries: Map<string, ZipEntry>) {
  const relationships = entries.get("_rels/.rels");
  const data = relationships ? await readZipEntry(bytes, relationships, 1024 * 1024) : null;
  if (data) {
    const text = utf8.decode(data);
    for (const match of text.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
      const values = stringAttributes(new TextEncoder().encode(match[1]!), 0, match[1]!.length);
      const target = values.get("Target");
      if (values.get("Type") === MODEL_RELATIONSHIP && target) return target.replace(/^\//, "");
    }
  }
  return DEFAULT_MODEL_PATH;
}

interface Placement {
  readonly object: ModelObject;
  readonly transform: Transform;
}

/** Returns `null` for data that is not 3MF, has no triangles, or exceeds `maxTriangles`. */
export async function parseThreeMf(
  bytes: Uint8Array,
  limits: MeshLimits,
  signal: AbortSignal,
): Promise<Mesh | null> {
  const entries = zipEntries(bytes);
  if (!entries) return null;
  const budget = workBudget(signal, TAGS_PER_SLICE);
  const parts = new Map<string, ModelPart | null>();
  let inflateRemaining = MAX_INFLATED_BYTES;
  const triangleBudget = { remaining: limits.maxTriangles };

  const loadPart = async (path: string) => {
    if (parts.has(path)) return parts.get(path)!;
    const entry = entries.get(path);
    const result = entry
      ? await parsePart(bytes, entry, budget, inflateRemaining, triangleBudget)
      : null;
    inflateRemaining -= result?.inflated ?? 0;
    parts.set(path, result?.part ?? null);
    return result?.part ?? null;
  };

  try {
    const rootPath = await rootModelPath(bytes, entries);
    const root = await loadPart(rootPath);
    if (!root) return null;

    // Resolve every placement first, so the result is allocated once at its final size.
    const placements: Placement[] = [];
    let placedTriangles = 0;
    let visits = 0;
    const place = async (item: Reference, partPath: string, outer: Transform, depth: number) => {
      if (depth > MAX_COMPONENT_DEPTH) return;
      // Fan-out, not depth, is what a few kilobytes of shared components can blow up.
      if ((visits += 1) > MAX_PLACEMENT_VISITS) throw new TooLarge();
      if (budget.spend()) await budget.pause();
      const path = item.path ?? partPath;
      const object = (await loadPart(path))?.objects.get(item.objectId);
      if (!object) return;
      const transform = compose(item.transform, outer);
      if (object.indices.length > 0) {
        placements.push({ object, transform });
        placedTriangles += object.indices.length / 3;
        if (placedTriangles > limits.maxTriangles) throw new TooLarge();
      }
      for (const component of object.components) {
        await place(component, path, transform, depth + 1);
      }
    };
    // Without build items, show each top-level object in the root part once.
    const used = new Set(
      [...root.objects.values()].flatMap((object) =>
        object.components
          .filter((component) => !component.path)
          .map((component) => component.objectId),
      ),
    );
    const items =
      root.build.length > 0
        ? root.build
        : [...root.objects.keys()]
            .filter((objectId) => !used.has(objectId))
            .map((objectId) => ({ objectId, path: null, transform: IDENTITY }));
    for (const item of items) await place(item, rootPath, IDENTITY, 0);
    if (placements.length === 0) return null;

    const transformInto = (target: Float32Array, offset: number, placement: Placement) => {
      const { object, transform: m } = placement;
      const source = object.points;
      for (let index = 0; index < source.length; index += 3) {
        const x = source[index]!;
        const y = source[index + 1]!;
        const z = source[index + 2]!;
        target[offset + index] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
        target[offset + index + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
        target[offset + index + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
      }
    };

    // One placement, the usual case: transform in place and reuse the object's own arrays,
    // dropping triangles whose corners are missing.
    if (placements.length === 1) {
      const only = placements[0]!;
      const { points, indices } = only.object;
      transformInto(points, 0, only);
      const count = points.length / 3;
      let kept = 0;
      for (let index = 0; index + 2 < indices.length; index += 3) {
        const a = indices[index]!;
        const b = indices[index + 1]!;
        const c = indices[index + 2]!;
        if (a >= count || b >= count || c >= count) continue;
        indices[kept] = a;
        indices[kept + 1] = b;
        indices[kept + 2] = c;
        kept += 3;
      }
      return kept === 0 ? null : { points, indices: indices.subarray(0, kept) };
    }

    const points = new Float32Array(
      placements.reduce((sum, placement) => sum + placement.object.points.length, 0),
    );
    const indices = new Uint32Array(placedTriangles * 3);
    let pointOffset = 0;
    let written = 0;
    for (const placement of placements) {
      const { object } = placement;
      transformInto(points, pointOffset, placement);
      const base = pointOffset / 3;
      const count = object.points.length / 3;
      for (let index = 0; index + 2 < object.indices.length; index += 3) {
        const a = object.indices[index]!;
        const b = object.indices[index + 1]!;
        const c = object.indices[index + 2]!;
        if (a >= count || b >= count || c >= count) continue;
        indices[written] = base + a;
        indices[written + 1] = base + b;
        indices[written + 2] = base + c;
        written += 3;
      }
      pointOffset += object.points.length;
      if (budget.spend(object.indices.length / 3)) await budget.pause();
    }
    if (written === 0) return null;
    return { points, indices: written === indices.length ? indices : indices.slice(0, written) };
  } catch (cause) {
    if (cause instanceof TooLarge) return null;
    throw cause;
  }
}
