// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import {
  paintDisplayList,
  type DisplayList,
  type GridMeta,
  type WorkbookHandle,
} from "@betteroffice/xlsx";
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
 * viewport it shows.
 */
export type Frame = {
  readonly list: DisplayList;
  readonly tiles: readonly Tile[];
  readonly viewport: SheetViewport;
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
  const around = wider && untruncated(workbook, wider);

  if (wider && around)
    return {
      list: around,
      tiles: [{ list: around, x: 0, y: 0, clipX: 0, clipY: 0 }],
      viewport: wider,
    };

  const whole = untruncated(workbook, viewport);

  if (whole)
    return { list: whole, tiles: [{ list: whole, x: 0, y: 0, clipX: 0, clipY: 0 }], viewport };

  // The engine refuses a viewport with too many cells, as a wide pane of narrow columns has. One row and one column of
  // the frame give its tracks, and so where its frozen panes end.
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

  return tiled(workbook, viewport, frozenSize(grid, frozen), grid, 2);
}

/** The engine's screen gridlines: one-pixel solid lines in its gridline grey, unlike any border it draws. */
const gridline = (command: DisplayList["commands"][number]) =>
  command.op === "line" && command.color === "#d4d4d4" && command.width === 1 && !command.style;

/** A frame without the gridlines the engine draws on every sheet, for a sheet whose view hides them. */
export function withoutGridlines(frame: Frame): Frame {
  return {
    ...frame,
    tiles: frame.tiles.map((tile) => ({
      ...tile,
      list: { ...tile.list, commands: tile.list.commands.filter((command) => !gridline(command)) },
    })),
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
 * tile covers the panes it repeats.
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

  frame.tiles.forEach((tile) => {
    const at = { x: origin.x + tile.x * ratio, y: origin.y + tile.y * ratio };
    const list = tiled
      ? { ...tile.list, commands: tile.list.commands.filter((command) => command.op !== "text") }
      : tile.list;

    if (tile.clipX === 0 && tile.clipY === 0) return paintDisplayList(painter, list, ratio, at);

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(
      Math.round(origin.x + tile.clipX * ratio),
      Math.round(origin.y + tile.clipY * ratio),
      context.canvas.width,
      context.canvas.height,
    );
    context.clip();
    paintDisplayList(painter, list, ratio, at);
    context.restore();
  });
  // Text clips can span a merged range beyond its tile. Composite it after all tile clears and backgrounds.
  if (text && textContext)
    frame.tiles.forEach((tile) => {
      textContext.reset();
      paintDisplayList(
        textContext as unknown as CanvasRenderingContext2D,
        {
          ...tile.list,
          width: frame.viewport.width - tile.x,
          height: frame.viewport.height - tile.y,
          commands: tile.list.commands.filter((command) => command.op === "text"),
        },
        ratio,
        { x: origin.x + tile.x * ratio, y: origin.y + tile.y * ratio },
      );
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.beginPath();
      context.rect(
        Math.round(origin.x + tile.clipX * ratio),
        Math.round(origin.y + tile.clipY * ratio),
        context.canvas.width,
        context.canvas.height,
      );
      context.clip();
      context.drawImage(text, 0, 0);
      context.restore();
    });
}

/**
 * A frame split into `split` tiles a side, each under the engine's cap. A tile past the first along an axis asks for
 * the frozen panes too, as every viewport has them, so the cells past them start just before its seam.
 */
function tiled(
  workbook: WorkbookHandle,
  viewport: SheetViewport,
  panes: { readonly width: number; readonly height: number },
  grid: GridMeta,
  split: number,
): Frame | undefined {
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

  if (complete) {
    const hyperlinks = tiles.flatMap((tile) => tile.list.hyperlinks ?? []);

    return {
      list: { width: viewport.width, height: viewport.height, commands: [], grid, hyperlinks },
      tiles,
      viewport,
    };
  }

  if (split >= maxSplit) return undefined;

  return tiled(workbook, viewport, panes, grid, split + 1);
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
