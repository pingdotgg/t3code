// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import { paintDisplayList, type DisplayList, type WorkbookHandle } from "@betteroffice/xlsx";
import { attempt } from "./sheet-cells";
import { frozenSize } from "./sheet-paint";
import type { SheetViewport } from "./sheet-protocol";

// The workbook worker's frames: the display lists of one viewport, split into tiles where the engine refuses it whole,
// and their painting.

/** The most tiles a side of a frame splits into before the frame gives up. */
const maxSplit = 8;

/**
 * How far a tile reaches past each of its seams, in CSS pixels. The engine draws pane dividers and cut tracks at a
 * frame's edges, which the next tile has to cover, and the seam falls inside a device pixel.
 */
const seamOverlap = 8;

/**
 * How far before a frame its cells are drawn from, in CSS pixels. The engine draws only the cells from a viewport's
 * first track on, so the text of a cell before it, overflowing or merged into the frame, would vanish with that cell.
 */
const reach = { x: 1024, y: 512 };

/** Part of a frame: its display list, where its origin sits in the frame, and where it starts to show. */
type Tile = {
  readonly list: DisplayList;
  readonly x: number;
  readonly y: number;
  readonly clipX: number;
  readonly clipY: number;
};

/**
 * A frame of cells: the tiles that draw it, one display list for its grid and links, without draw commands, and the
 * viewport it shows. The tiles' cells past the frozen panes start `behind` the viewport's.
 */
export type Frame = {
  readonly list: DisplayList;
  readonly tiles: readonly Tile[];
  readonly viewport: SheetViewport;
  readonly behind: { readonly x: number; readonly y: number };
  readonly panes: { readonly width: number; readonly height: number };
};

/**
 * The cells of one viewport, as the engine draws them; `undefined` when even its smallest tiles fail. A `wider`
 * viewport around it is drawn instead when the engine takes it whole.
 */
export function drawFrame(
  workbook: WorkbookHandle,
  viewport: SheetViewport,
  frozen: { readonly rows: number; readonly cols: number },
  wider?: SheetViewport,
): Frame | undefined {
  return (
    (wider && reaching(workbook, wider, frozen, false)) ||
    reaching(workbook, viewport, frozen, true)
  );
}

/** A frame of `viewport` drawn from up to `reach` before it, split into tiles when `split` and the engine needs it. */
function reaching(
  workbook: WorkbookHandle,
  viewport: SheetViewport,
  frozen: { readonly rows: number; readonly cols: number },
  split: boolean,
): Frame | undefined {
  // One row and one column of the viewport give its tracks, and so where its frozen panes end.
  const columns = untruncated(workbook, { ...viewport, height: 1 })?.grid;
  const rows = untruncated(workbook, { ...viewport, width: 1 })?.grid;

  if (!columns || !rows) return undefined;

  const grid = {
    startRow: rows.startRow,
    ...(rows.rowIndices ? { rowIndices: rows.rowIndices } : {}),
    rowOffsets: rows.rowOffsets,
    startCol: columns.startCol,
    ...(columns.colIndices ? { colIndices: columns.colIndices } : {}),
    colOffsets: columns.colOffsets,
  };
  const panes = frozenSize(grid, frozen);
  const behind = { x: Math.min(reach.x, viewport.x), y: Math.min(reach.y, viewport.y) };
  const area = {
    x: viewport.x - behind.x,
    y: viewport.y - behind.y,
    width: viewport.width + behind.x,
    height: viewport.height + behind.y,
  };
  const whole = untruncated(workbook, area);
  // The engine refuses a viewport with too many cells, as a wide pane of narrow columns has.
  const tiles = whole
    ? [{ list: whole, x: 0, y: 0, clipX: 0, clipY: 0 }]
    : split
      ? tiled(workbook, area, panes, 2)
      : undefined;

  if (!tiles) return undefined;

  const hyperlinks = tiles.flatMap((tile) => tile.list.hyperlinks ?? []);

  return {
    list: { width: viewport.width, height: viewport.height, commands: [], grid, hyperlinks },
    tiles,
    viewport,
    behind,
    panes,
  };
}

/**
 * A frame whose chart text names real fonts. The engine leaves the theme's `+mj-lt` and `+mn-lt` in chart text and the
 * painter sets chart families as CSS as they are, so an unresolved or missing family would keep the previous font.
 */
export function chartFonts(
  frame: Frame,
  theme: { readonly major: string; readonly minor: string },
): Frame {
  const family = (name: string) => {
    const resolved = name.startsWith("+mj-")
      ? theme.major
      : name.startsWith("+mn-")
        ? theme.minor
        : name;
    return `"${resolved.replaceAll('"', "")}", sans-serif`;
  };

  return {
    ...frame,
    tiles: frame.tiles.map((tile) => ({
      ...tile,
      list: {
        ...tile.list,
        commands: tile.list.commands.map((command) =>
          command.op === "text" && command.chart
            ? { ...command, fontFamily: family(command.fontFamily ?? theme.minor) }
            : command,
        ),
      },
    })),
  };
}

/**
 * Draws a frame's tiles with the cells' top-left corner at `origin`, in device pixels, each tile from its seam on, so a
 * tile covers the panes it repeats. The cells past the frozen panes move back by `behind`; the panes stay put.
 */
export function paintFrame(
  context: OffscreenCanvasRenderingContext2D,
  frame: Frame,
  input: { readonly ratio: number; readonly origin: { readonly x: number; readonly y: number } },
) {
  const ratio = input.ratio;
  const origin = input.origin;
  // SAFETY: the painter draws through the members a worker's 2D context shares with the window's. Only the window's
  // context type is declared, and it has focus and attribute members the worker's lacks, hence the double cast.
  const painter = context as unknown as CanvasRenderingContext2D;
  const tiled = frame.tiles.length > 1;
  const text = tiled ? new OffscreenCanvas(context.canvas.width, context.canvas.height) : undefined;
  const textContext = text?.getContext("2d");
  const columns = bands(frame.panes.width, frame.behind.x);
  const rows = bands(frame.panes.height, frame.behind.y);
  const parts = frame.tiles.flatMap((tile) =>
    rows.flatMap((row) =>
      columns.flatMap((column) => {
        const left = Math.max(column.start, tile.clipX - column.shift);
        const top = Math.max(row.start, tile.clipY - row.shift);

        if (left >= column.end || top >= row.end) return [];

        const clip = {
          left: Math.round(origin.x + left * ratio),
          top: Math.round(origin.y + top * ratio),
          right: Math.round(origin.x + column.end * ratio),
          bottom: Math.round(origin.y + row.end * ratio),
        };

        return [
          {
            tile,
            at: {
              x: origin.x + (tile.x - column.shift) * ratio,
              y: origin.y + (tile.y - row.shift) * ratio,
            },
            clip:
              left === 0 && top === 0 && column.end === Infinity && row.end === Infinity
                ? undefined
                : clip,
          },
        ];
      }),
    ),
  );
  const clipped = (clip: (typeof parts)[number]["clip"], paint: () => void) => {
    if (!clip) return paint();

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(
      clip.left,
      clip.top,
      Math.min(clip.right, context.canvas.width) - clip.left,
      Math.min(clip.bottom, context.canvas.height) - clip.top,
    );
    context.clip();
    paint();
    context.restore();
  };

  parts.forEach(({ tile, at, clip }) => {
    const list = tiled
      ? { ...tile.list, commands: tile.list.commands.filter((command) => command.op !== "text") }
      : tile.list;

    clipped(clip, () => paintDisplayList(painter, list, ratio, at));
  });
  // Text clips can span a merged range beyond its tile. Composite it after all tile clears and backgrounds.
  if (text && textContext)
    parts.forEach(({ tile, at, clip }) => {
      textContext.reset();
      paintDisplayList(
        textContext as unknown as CanvasRenderingContext2D,
        {
          ...tile.list,
          width: frame.viewport.width + frame.behind.x - tile.x,
          height: frame.viewport.height + frame.behind.y - tile.y,
          commands: tile.list.commands.filter((command) => command.op === "text"),
        },
        ratio,
        at,
      );
      clipped(clip, () => context.drawImage(text, 0, 0));
    });
}

/** A side's frozen pane, drawn where it is, and the cells past it, drawn `behind` further on. */
function bands(panes: number, behind: number) {
  return panes > 0 && behind > 0
    ? [
        { start: 0, end: panes, shift: 0 },
        { start: panes, end: Infinity, shift: behind },
      ]
    : [{ start: 0, end: Infinity, shift: behind }];
}

/**
 * A frame split into `split` tiles a side, each under the engine's cap. A tile past the first along an axis asks for
 * the frozen panes too, as every viewport has them, so the cells past them start just before its seam.
 */
function tiled(
  workbook: WorkbookHandle,
  viewport: SheetViewport,
  panes: { readonly width: number; readonly height: number },
  split: number,
): Tile[] | undefined {
  const columns = segments(viewport.width, panes.width, split);
  const rows = segments(viewport.height, panes.height, split);
  const tiles: Tile[] = [];

  const complete = rows.every((row) =>
    columns.every((column) => {
      const x = column.start === 0 ? 0 : column.start - seamOverlap - panes.width;
      const y = row.start === 0 ? 0 : row.start - seamOverlap - panes.height;
      // A tile but the last along an axis reaches past its end, which the next tile paints over.
      const right = column.end === viewport.width ? column.end : column.end + seamOverlap;
      const bottom = row.end === viewport.height ? row.end : row.end + seamOverlap;

      const list = untruncated(workbook, {
        x: viewport.x + x,
        y: viewport.y + y,
        width: right - x,
        height: bottom - y,
      });

      if (list) tiles.push({ list, x, y, clipX: column.start, clipY: row.start });

      return !!list;
    }),
  );

  if (complete) return tiles;

  if (split >= maxSplit) return undefined;

  return tiled(workbook, viewport, panes, split + 1);
}

/** A viewport's display list, or undefined where the engine refuses it or cuts it short at its cell limit. */
function untruncated(workbook: WorkbookHandle, viewport: SheetViewport) {
  const list = attempt(() => workbook.displayList(viewport));

  return list?.truncated ? undefined : list;
}

/** Even spans of a side, the first holding the frozen panes whole; a seam inside them is dropped. */
function segments(size: number, panes: number, split: number) {
  const starts = Array.from({ length: split }, (_, part) =>
    Math.round((part * size) / split),
  ).filter((start, part) => part === 0 || (start >= panes + seamOverlap && start < size));

  return starts.map((start, part) => ({ start, end: starts[part + 1] ?? size }));
}
