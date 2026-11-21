import type { CanvasLayout } from "@t3tools/contracts";

let lineStarts = new Int32Array(64);
let lineEnds = new Int32Array(64);
let lineMain = new Float64Array(64);
let lineCross = new Float64Array(64);

function ensureLines(count: number) {
  if (lineStarts.length >= count) return;
  const size = Math.max(count, lineStarts.length * 2);
  lineStarts = new Int32Array(size);
  lineEnds = new Int32Array(size);
  lineMain = new Float64Array(size);
  lineCross = new Float64Array(size);
}

/**
 * Lays out `children` of a frame with flexbox-shaped auto layout. `geom` holds
 * `[x, y, width, height]` per node index; children's width/height are read as
 * their intrinsic size and x/y (plus the stretched cross size) are written back.
 */
export function layoutChildren(
  layout: CanvasLayout,
  frameWidth: number,
  frameHeight: number,
  children: ArrayLike<number>,
  count: number,
  geom: Float64Array,
): void {
  if (count === 0) return;
  const row = layout.direction === "row";
  const gap = layout.gap ?? 0;
  const [padTop, padRight, padBottom, padLeft] = layout.padding ?? [0, 0, 0, 0];
  const mainStart = row ? padLeft : padTop;
  const crossStart = row ? padTop : padLeft;
  const innerWidth = Math.max(0, frameWidth - padLeft - padRight);
  const innerHeight = Math.max(0, frameHeight - padTop - padBottom);
  const mainAvail = row ? innerWidth : innerHeight;
  const crossAvail = row ? innerHeight : innerWidth;
  const mainOff = row ? 2 : 3;
  const crossOff = row ? 3 : 2;
  const align = layout.align ?? "start";
  const justify = layout.justify ?? "start";

  ensureLines(count + 1);
  let lines = 0;
  let start = 0;
  let main = 0;
  let cross = 0;
  for (let k = 0; k < count; k++) {
    const index = children[k]!;
    const size = geom[index * 4 + mainOff]!;
    const next = k === start ? size : main + gap + size;
    if (layout.wrap === true && k > start && next > mainAvail) {
      lineStarts[lines] = start;
      lineEnds[lines] = k;
      lineMain[lines] = main;
      lineCross[lines] = cross;
      lines++;
      start = k;
      main = size;
      cross = geom[index * 4 + crossOff]!;
    } else {
      main = next;
      cross = Math.max(cross, geom[index * 4 + crossOff]!);
    }
  }
  lineStarts[lines] = start;
  lineEnds[lines] = count;
  lineMain[lines] = main;
  lineCross[lines] = cross;
  lines++;

  let crossCursor = crossStart;
  for (let line = 0; line < lines; line++) {
    const from = lineStarts[line]!;
    const to = lineEnds[line]!;
    const items = to - from;
    // A single unwrapped line owns the whole cross axis, like CSS flex.
    const lineSize = lines === 1 ? crossAvail : lineCross[line]!;
    const free = mainAvail - lineMain[line]!;
    let cursor = mainStart;
    let spacing = gap;
    if (justify === "center") cursor += free / 2;
    else if (justify === "end") cursor += free;
    else if (justify === "space-between" && items > 1) spacing = gap + free / (items - 1);
    for (let k = from; k < to; k++) {
      const base = children[k]! * 4;
      let crossSize = geom[base + crossOff]!;
      let crossPos = crossCursor;
      if (align === "stretch") crossSize = lineSize;
      else if (align === "center") crossPos += (lineSize - crossSize) / 2;
      else if (align === "end") crossPos += lineSize - crossSize;
      geom[base + crossOff] = crossSize;
      geom[base + (row ? 0 : 1)] = cursor;
      geom[base + (row ? 1 : 0)] = crossPos;
      cursor += geom[base + mainOff]! + spacing;
    }
    crossCursor += lineSize + gap;
  }
}
