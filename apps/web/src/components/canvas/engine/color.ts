/**
 * Color parsing for the canvas engine. Colors are packed as straight RGBA in
 * one u32 (`r | g << 8 | b << 16 | a << 24`), which is also the byte order an
 * `UNSIGNED_BYTE` vertex attribute reads on little-endian hosts.
 */

const cache = new Map<string, number>();
let probe: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

const pack = (r: number, g: number, b: number, a: number) =>
  ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;

function parseHex(hex: string): number | null {
  const h = hex.slice(1);
  const digit = (index: number) => Number.parseInt(h[index]! + h[index]!, 16);
  const pair = (index: number) => Number.parseInt(h.slice(index, index + 2), 16);
  let value: number[];
  if (h.length === 3 || h.length === 4) {
    value = [digit(0), digit(1), digit(2), h.length === 4 ? digit(3) : 255];
  } else if (h.length === 6 || h.length === 8) {
    value = [pair(0), pair(2), pair(4), h.length === 8 ? pair(6) : 255];
  } else {
    return null;
  }
  if (value.some((part) => Number.isNaN(part))) return null;
  return pack(value[0]!, value[1]!, value[2]!, value[3]!);
}

function parseFunctional(input: string): number | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (!match) return null;
  const parts = match[1]!.split(/[\s,/]+/).filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  const channel = (part: string) =>
    part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part);
  const alphaPart = parts[3];
  const alpha =
    alphaPart === undefined
      ? 1
      : alphaPart.endsWith("%")
        ? Number.parseFloat(alphaPart) / 100
        : Number.parseFloat(alphaPart);
  const values = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha * 255];
  if (values.some((value) => Number.isNaN(value))) return null;
  return pack(
    Math.round(values[0]!),
    Math.round(values[1]!),
    Math.round(values[2]!),
    Math.round(Math.min(255, Math.max(0, values[3]!))),
  );
}

function parseWithCanvas(input: string): number {
  if (probe === null) {
    probe =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(1, 1).getContext("2d")
        : document.createElement("canvas").getContext("2d");
  }
  if (probe === null) return 0;
  probe.fillStyle = "#000000";
  probe.fillStyle = input;
  const normalized = String(probe.fillStyle);
  return normalized.startsWith("#")
    ? (parseHex(normalized) ?? 0)
    : (parseFunctional(normalized) ?? 0);
}

/** Parses any CSS color into straight packed RGBA. Results are cached. */
export function parseColor(input: string): number {
  const cached = cache.get(input);
  if (cached !== undefined) return cached;
  const trimmed = input.trim();
  let value: number | null = null;
  if (trimmed.startsWith("#")) value = parseHex(trimmed);
  else if (trimmed === "transparent") value = 0;
  else value = parseFunctional(trimmed);
  const result = value ?? parseWithCanvas(trimmed);
  if (cache.size > 4096) cache.clear();
  cache.set(input, result);
  return result;
}

/** Premultiplies a straight packed color, scaling alpha by `opacity`. */
export function premultiply(color: number, opacity: number): number {
  const alpha = ((color >>> 24) / 255) * opacity;
  if (alpha <= 0) return 0;
  return pack(
    Math.round((color & 255) * alpha),
    Math.round(((color >>> 8) & 255) * alpha),
    Math.round(((color >>> 16) & 255) * alpha),
    Math.round(alpha * 255),
  );
}

/** Interpolates two straight packed colors in premultiplied space, returning straight. */
export function mixColor(from: number, to: number, t: number): number {
  const fa = (from >>> 24) / 255;
  const ta = (to >>> 24) / 255;
  const a = fa + (ta - fa) * t;
  if (a <= 0) return 0;
  const channel = (shift: number) => {
    const f = ((from >>> shift) & 255) * fa;
    const v = ((to >>> shift) & 255) * ta;
    return Math.round((f + (v - f) * t) / a);
  };
  return pack(channel(0), channel(8), channel(16), Math.round(a * 255));
}

/** Writes premultiplied 0..1 floats for `color` into `out`. */
export function toPremultipliedFloats(color: number, out: Float32Array): void {
  const a = (color >>> 24) / 255;
  out[0] = ((color & 255) / 255) * a;
  out[1] = (((color >>> 8) & 255) / 255) * a;
  out[2] = (((color >>> 16) & 255) / 255) * a;
  out[3] = a;
}
