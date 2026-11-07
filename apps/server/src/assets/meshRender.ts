import type { Mesh } from "@t3tools/shared/meshFiles";

export interface MeshRenderOptions {
  /** Longest side of the output image. */
  readonly size: number;
  /** Rendering at a multiple of `size` and averaging smooths edges. */
  readonly supersample: number;
  /** Rough units of work (vertices, triangles, samples tested) between event loop yields. */
  readonly workPerSlice: number;
}

const MESH_RENDER_OPTIONS: MeshRenderOptions = {
  size: 512,
  supersample: 2,
  workPerSlice: 2_000_000,
};

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

type Vector = readonly [number, number, number];

const normalize = ([x, y, z]: Vector): Vector => {
  const length = Math.hypot(x, y, z);
  return length === 0 ? [0, 0, 0] : [x / length, y / length, z / length];
};
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// CAD and print formats are Z-up; look from the front right, 30 degrees above the horizon.
const AZIMUTH = Math.PI / 4;
const ELEVATION = Math.PI / 6;
const TOWARD_CAMERA = normalize([
  Math.cos(ELEVATION) * Math.sin(AZIMUTH),
  -Math.cos(ELEVATION) * Math.cos(AZIMUTH),
  Math.sin(ELEVATION),
]);
const SCREEN_RIGHT = normalize(
  cross([-TOWARD_CAMERA[0], -TOWARD_CAMERA[1], -TOWARD_CAMERA[2]], [0, 0, 1]),
);
const SCREEN_UP = cross(SCREEN_RIGHT, [-TOWARD_CAMERA[0], -TOWARD_CAMERA[1], -TOWARD_CAMERA[2]]);
// Key light from over the viewer's left shoulder.
const LIGHT = normalize([
  TOWARD_CAMERA[0] - SCREEN_RIGHT[0] * 0.5 + SCREEN_UP[0] * 0.6,
  TOWARD_CAMERA[1] - SCREEN_RIGHT[1] * 0.5 + SCREEN_UP[1] * 0.6,
  TOWARD_CAMERA[2] - SCREEN_RIGHT[2] * 0.5 + SCREEN_UP[2] * 0.6,
]);
const BASE_COLOR: Vector = [176, 186, 200];
const AMBIENT = 0.32;
const MARGIN = 0.06;

// Rendering runs in batches that yield here, so a large mesh does not stall the server.
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Returns `null` when the mesh has no visible extent or contains non-finite coordinates. */
export async function renderMesh(
  mesh: Mesh,
  signal: AbortSignal,
  options: MeshRenderOptions = MESH_RENDER_OPTIONS,
): Promise<RgbaImage | null> {
  const { points, indices } = mesh;
  const vertexCount = points.length / 3;
  const triangleCount = indices ? indices.length / 3 : Math.floor(vertexCount / 3);
  // Find the projected bounds. Corners are projected again while drawing, which costs less than
  // holding a projected copy of every vertex.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let work = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if ((work += 8) >= options.workPerSlice) {
      work = 0;
      await yieldToEventLoop();
      signal.throwIfAborted();
    }
    const px = points[vertex * 3]!;
    const py = points[vertex * 3 + 1]!;
    const pz = points[vertex * 3 + 2]!;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
    const x = px * SCREEN_RIGHT[0] + py * SCREEN_RIGHT[1] + pz * SCREEN_RIGHT[2];
    const y = px * SCREEN_UP[0] + py * SCREEN_UP[1] + pz * SCREEN_UP[2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  if (!(extentX > 0) && !(extentY > 0)) return null;

  // Fit the projected bounds, keeping the image's aspect ratio close to the model's.
  const longest = Math.max(extentX, extentY);
  const width = Math.max(1, Math.round((options.size * extentX) / longest));
  const height = Math.max(1, Math.round((options.size * extentY) / longest));
  const scale = options.supersample;
  const renderWidth = width * scale;
  const renderHeight = height * scale;
  const pixelsPerUnit = (Math.max(renderWidth, renderHeight) * (1 - 2 * MARGIN)) / longest;
  const offsetX = (renderWidth - extentX * pixelsPerUnit) / 2;
  const offsetY = (renderHeight - extentY * pixelsPerUnit) / 2;
  const depth = new Float32Array(renderWidth * renderHeight).fill(-Infinity);
  const shade = new Float32Array(renderWidth * renderHeight);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (work >= options.workPerSlice) {
      work = 0;
      await yieldToEventLoop();
      signal.throwIfAborted();
    }
    work += 32;
    const a = indices ? indices[triangle * 3]! : triangle * 3;
    const b = indices ? indices[triangle * 3 + 1]! : triangle * 3 + 1;
    const c = indices ? indices[triangle * 3 + 2]! : triangle * 3 + 2;
    const edgeA: Vector = [
      points[b * 3]! - points[a * 3]!,
      points[b * 3 + 1]! - points[a * 3 + 1]!,
      points[b * 3 + 2]! - points[a * 3 + 2]!,
    ];
    const edgeB: Vector = [
      points[c * 3]! - points[a * 3]!,
      points[c * 3 + 1]! - points[a * 3 + 1]!,
      points[c * 3 + 2]! - points[a * 3 + 2]!,
    ];
    // STL winding is unreliable, so light both faces alike.
    const intensity =
      AMBIENT + (1 - AMBIENT) * Math.abs(dot(normalize(cross(edgeA, edgeB)), LIGHT));

    const screenX = (vertex: number) =>
      offsetX +
      (points[vertex * 3]! * SCREEN_RIGHT[0] +
        points[vertex * 3 + 1]! * SCREEN_RIGHT[1] +
        points[vertex * 3 + 2]! * SCREEN_RIGHT[2] -
        minX) *
        pixelsPerUnit;
    const screenY = (vertex: number) =>
      renderHeight -
      (offsetY +
        (points[vertex * 3]! * SCREEN_UP[0] +
          points[vertex * 3 + 1]! * SCREEN_UP[1] +
          points[vertex * 3 + 2]! * SCREEN_UP[2] -
          minY) *
          pixelsPerUnit);
    const depthOf = (vertex: number) =>
      points[vertex * 3]! * TOWARD_CAMERA[0] +
      points[vertex * 3 + 1]! * TOWARD_CAMERA[1] +
      points[vertex * 3 + 2]! * TOWARD_CAMERA[2];
    const x0 = screenX(a);
    const y0 = screenY(a);
    const z0 = depthOf(a);
    const x1 = screenX(b);
    const y1 = screenY(b);
    const z1 = depthOf(b);
    const x2 = screenX(c);
    const y2 = screenY(c);
    const z2 = depthOf(c);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) continue;
    const left = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const right = Math.min(renderWidth - 1, Math.ceil(Math.max(x0, x1, x2)));
    const top = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const bottom = Math.min(renderHeight - 1, Math.ceil(Math.max(y0, y1, y2)));
    work += Math.max(0, right - left + 1) * Math.max(0, bottom - top + 1);
    for (let py = top; py <= bottom; py += 1) {
      const sampleY = py + 0.5;
      for (let px = left; px <= right; px += 1) {
        const sampleX = px + 0.5;
        const w0 = ((x1 - sampleX) * (y2 - sampleY) - (x2 - sampleX) * (y1 - sampleY)) / area;
        const w1 = ((x2 - sampleX) * (y0 - sampleY) - (x0 - sampleX) * (y2 - sampleY)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const index = py * renderWidth + px;
        if (z <= depth[index]!) continue;
        depth[index] = z;
        shade[index] = intensity;
      }
    }
  }

  // Average each block of samples; uncovered samples stay transparent.
  const rgba = new Uint8Array(width * height * 4);
  const samples = scale * scale;
  for (let y = 0; y < height; y += 1) {
    if (y > 0 && y % 64 === 0) {
      await yieldToEventLoop();
      signal.throwIfAborted();
    }
    for (let x = 0; x < width; x += 1) {
      let covered = 0;
      let light = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = (y * scale + sy) * renderWidth + x * scale + sx;
          if (depth[index] === -Infinity) continue;
          covered += 1;
          light += shade[index]!;
        }
      }
      if (covered === 0) continue;
      const pixel = (y * width + x) * 4;
      const average = light / covered;
      rgba[pixel] = Math.round(BASE_COLOR[0] * average);
      rgba[pixel + 1] = Math.round(BASE_COLOR[1] * average);
      rgba[pixel + 2] = Math.round(BASE_COLOR[2] * average);
      rgba[pixel + 3] = Math.round((255 * covered) / samples);
    }
  }
  return { width, height, rgba };
}
