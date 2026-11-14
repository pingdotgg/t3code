import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttySnapshot,
} from "./core";

export interface GhosttyCellMetrics {
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

export interface GhosttyCellRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

const DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)";
const POWERLINE_LINE_WIDTH = 1;

type CellPoint = readonly [x: number, y: number];
type PowerlineShape =
  | { readonly kind: "fill"; readonly points: readonly CellPoint[] }
  | { readonly kind: "stroke"; readonly points: readonly CellPoint[] }
  | { readonly kind: "cap"; readonly flatEdge: "left" | "right"; readonly filled: boolean };

// prettier-ignore
const POWERLINE_SHAPES: ReadonlyMap<string, PowerlineShape> = new Map([
  ["\ue0b0", { kind: "fill", points: [[0, 0], [1, 0.5], [0, 1]] }],
  ["\ue0b1", { kind: "stroke", points: [[0, 0], [1, 0.5], [0, 1]] }],
  ["\ue0b2", { kind: "fill", points: [[1, 0], [0, 0.5], [1, 1]] }],
  ["\ue0b3", { kind: "stroke", points: [[1, 0], [0, 0.5], [1, 1]] }],
  ["\ue0b4", { kind: "cap", flatEdge: "left", filled: true }],
  ["\ue0b5", { kind: "cap", flatEdge: "left", filled: false }],
  ["\ue0b6", { kind: "cap", flatEdge: "right", filled: true }],
  ["\ue0b7", { kind: "cap", flatEdge: "right", filled: false }],
  ["\ue0b8", { kind: "fill", points: [[0, 0], [1, 1], [0, 1]] }],
  ["\ue0b9", { kind: "stroke", points: [[0, 0], [1, 1]] }],
  ["\ue0ba", { kind: "fill", points: [[1, 0], [1, 1], [0, 1]] }],
  ["\ue0bb", { kind: "stroke", points: [[1, 0], [0, 1]] }],
  ["\ue0bc", { kind: "fill", points: [[0, 0], [1, 0], [0, 1]] }],
  ["\ue0bd", { kind: "stroke", points: [[1, 0], [0, 1]] }],
  ["\ue0be", { kind: "fill", points: [[0, 0], [1, 0], [1, 1]] }],
  ["\ue0bf", { kind: "stroke", points: [[0, 0], [1, 1]] }],
]);

function cssColor(color: GhosttyColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  // Selection only tints the background; splitting text runs shifts glyph spacing when advances differ from cell width.
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  );
}

// Fonts inset or scale these private-use glyphs, leaving gaps where they should
// meet the neighboring cells. Draw them from the cell's own edges, as Ghostty does.
function drawPowerlineShape(
  context: CanvasRenderingContext2D,
  shape: PowerlineShape,
  color: string,
  left: number,
  top: number,
  width: number,
  height: number,
  seamOverlap: number,
): void {
  const filled = shape.kind === "fill" || (shape.kind === "cap" && shape.filled);
  context.save();
  if (!filled) {
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
  }
  context.beginPath();
  if (shape.kind === "cap") {
    const inset = filled ? 0 : POWERLINE_LINE_WIDTH / 2;
    const [base, start] =
      shape.flatEdge === "left" ? [left, -Math.PI / 2] : [left + width, Math.PI / 2];
    context.ellipse(
      base,
      top + height / 2,
      width - inset,
      height / 2 - inset,
      0,
      start,
      start + Math.PI,
    );
    if (filled) {
      context.closePath();
      // Overlap the segment this cap closes so anti-aliasing at a fractional
      // cell edge does not leave a hairline seam.
      const inward = shape.flatEdge === "left" ? -1 : 1;
      context.rect(Math.min(base, base + inward * seamOverlap), top, seamOverlap, height);
    }
  } else {
    for (const [x, y] of shape.points) context.lineTo(left + x * width, top + y * height);
  }
  if (filled) {
    context.fillStyle = color;
    context.fill();
  } else {
    context.strokeStyle = color;
    context.lineWidth = POWERLINE_LINE_WIDTH;
    context.lineCap = "butt";
    context.stroke();
  }
  context.restore();
}

function ghosttyTextRunEnd(
  cells: readonly GhosttyCell[],
  start: number,
  sameStyle: (cell: GhosttyCell) => boolean,
): number {
  let end = start + 1;
  while (end < cells.length) {
    const next = cells[end];
    if (!next) break;
    if (next.wide === GHOSTTY_CELL_WIDE.spacerTail) {
      end += 1;
      continue;
    }
    if (next.text.length === 0 || POWERLINE_SHAPES.has(next.text) || !sameStyle(next)) break;
    end += 1;
  }
  return end;
}

// Snapshots decode `wide` only for empty cells, so a wide glyph is known by its spacer tail.
function isWideGlyph(cells: readonly GhosttyCell[], index: number): boolean {
  return cells[index + 1]?.wide === GHOSTTY_CELL_WIDE.spacerTail;
}

// Wide glyphs rarely advance exactly two cells, so each is centred in its own box
// and the narrow text after it restarts at its own column instead of drifting.
function fillGhosttyRunText(
  context: CanvasRenderingContext2D,
  cells: readonly GhosttyCell[],
  start: number,
  end: number,
  text: string,
  left: number,
  baseline: number,
  cellWidth: number,
): void {
  let segment = start;
  while (segment < end) {
    let segmentEnd = segment;
    while (segmentEnd < end && !isWideGlyph(cells, segmentEnd)) segmentEnd += 1;
    if (segmentEnd > segment) {
      const segmentText =
        segment === start && segmentEnd === end
          ? text
          : cells
              .slice(segment, segmentEnd)
              .map((cell) => cell.text)
              .join("");
      context.fillText(
        segmentText,
        left + (segment - start) * cellWidth,
        baseline,
        (segmentEnd - segment) * cellWidth,
      );
    }
    if (segmentEnd === end) break;
    context.textAlign = "center";
    context.fillText(
      cells[segmentEnd]?.text ?? "",
      left + (segmentEnd - start + 1) * cellWidth,
      baseline,
      cellWidth * 2,
    );
    context.textAlign = "start";
    segment = segmentEnd + 2;
  }
}

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const style = cell.italic ? "italic" : "normal";
  const weight = cell.bold ? "700" : "400";
  return `${style} ${weight} ${fontSize}px ${fontFamily}`;
}

export function measureGhosttyCell(
  context: CanvasRenderingContext2D,
  fontSize: number,
  fontFamily: string,
): GhosttyCellMetrics {
  context.font = `normal 400 ${fontSize}px ${fontFamily}`;
  const widthMeasurement = context.measureText("M");
  const verticalMeasurement = context.measureText("Mg");
  const ascent = verticalMeasurement.actualBoundingBoxAscent || fontSize;
  const descent = verticalMeasurement.actualBoundingBoxDescent;
  const glyphHeight = ascent + descent;
  const height = Math.max(1, Math.round(fontSize * 1.35), Math.ceil(glyphHeight));
  return {
    width: Math.max(1, widthMeasurement.width),
    height,
    baseline: Math.round((height - glyphHeight) / 2 + ascent),
  };
}

export function terminalGridSize(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((width - padding * 2) / metrics.width)),
    rows: Math.max(1, Math.floor((height - padding * 2) / metrics.height)),
  };
}

export function renderGhosttySnapshot(options: {
  readonly context: CanvasRenderingContext2D;
  readonly snapshot: GhosttySnapshot;
  readonly metrics: GhosttyCellMetrics;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly padding: number;
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused?: boolean;
  readonly selectionBackground?: string;
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  readonly originY?: number;
}): void {
  const {
    context,
    snapshot,
    metrics,
    fontSize,
    fontFamily,
    padding,
    forceFull,
    cursorOn,
    previousCursorY,
  } = options;
  const focused = options.focused ?? true;
  const selectionBackground = options.selectionBackground ?? DEFAULT_SELECTION_BACKGROUND;
  const hoveredLinkRange = options.hoveredLinkRange ?? null;
  const originY = options.originY ?? padding;
  // Rows start on whole device pixels and clear the full canvas width, so repainting
  // a row replaces every pixel the last frame drew in it, including a cursor's edges.
  const transform = context.getTransform();
  const rowTop = (row: number) =>
    Math.round((originY + row * metrics.height) * transform.d) / transform.d;
  const rowWidth = context.canvas.width / transform.a;
  const rowsToDraw = forceFull
    ? Array.from({ length: snapshot.rows }, (_, index) => index)
    : [...snapshot.dirtyRows];
  if (
    previousCursorY !== null &&
    previousCursorY !== undefined &&
    previousCursorY >= 0 &&
    !rowsToDraw.includes(previousCursorY)
  ) {
    rowsToDraw.push(previousCursorY);
  }
  if (snapshot.cursorVisible && snapshot.cursorY >= 0 && !rowsToDraw.includes(snapshot.cursorY)) {
    rowsToDraw.push(snapshot.cursorY);
  }

  if (forceFull) {
    context.save();
    context.resetTransform();
    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  context.textBaseline = "alphabetic";
  for (const rowIndex of rowsToDraw) {
    const row = snapshot.rowData[rowIndex];
    if (!row) continue;
    const top = rowTop(rowIndex);
    const height = rowTop(rowIndex + 1) - top;

    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(0, top, rowWidth, height);

    let backgroundStart = 0;
    while (backgroundStart < row.cells.length) {
      const first = row.cells[backgroundStart];
      if (!first) break;
      let backgroundEnd = backgroundStart + 1;
      while (backgroundEnd < row.cells.length) {
        const next = row.cells[backgroundEnd];
        if (
          !next ||
          next.selected !== first.selected ||
          !ghosttyColorsEqual(next.background, first.background)
        ) {
          break;
        }
        backgroundEnd += 1;
      }
      if (first.selected || !ghosttyColorsEqual(first.background, snapshot.background)) {
        const left = padding + backgroundStart * metrics.width;
        const width = (backgroundEnd - backgroundStart) * metrics.width;
        if (!ghosttyColorsEqual(first.background, snapshot.background)) {
          context.fillStyle = cssColor(first.background);
          context.fillRect(left, top, width, height);
        }
        if (first.selected) {
          context.fillStyle = selectionBackground;
          context.fillRect(left, top, width, height);
        }
      }
      backgroundStart = backgroundEnd;
    }

    let runStart = 0;
    while (runStart < row.cells.length) {
      const first = row.cells[runStart];
      if (!first) break;
      if (first.text.length === 0) {
        runStart += 1;
        continue;
      }
      const powerlineShape = POWERLINE_SHAPES.get(first.text);
      if (powerlineShape) {
        if (!first.invisible) {
          drawPowerlineShape(
            context,
            powerlineShape,
            cssColor(first.foreground),
            padding + runStart * metrics.width,
            top,
            metrics.width,
            height,
            1,
          );
        }
        runStart += 1;
        continue;
      }
      const runEnd = ghosttyTextRunEnd(row.cells, runStart, (cell) => sameTextStyle(cell, first));
      const text = row.cells
        .slice(runStart, runEnd)
        .map((cell) => cell.text)
        .join("");
      if (!first.invisible && text.trim().length > 0) {
        context.save();
        context.beginPath();
        context.rect(
          padding + runStart * metrics.width,
          top,
          (runEnd - runStart) * metrics.width,
          height,
        );
        context.clip();
        context.font = fontForCell(first, fontSize, fontFamily);
        context.fillStyle = cssColor(first.foreground);
        fillGhosttyRunText(
          context,
          row.cells,
          runStart,
          runEnd,
          text,
          padding + runStart * metrics.width,
          top + metrics.baseline,
          metrics.width,
        );
        context.restore();
      }
      runStart = runEnd;
    }

    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const hoveredLink =
        hoveredLinkRange !== null &&
        rowIndex >= hoveredLinkRange.start.y &&
        rowIndex <= hoveredLinkRange.end.y &&
        (rowIndex > hoveredLinkRange.start.y || column >= hoveredLinkRange.start.x) &&
        (rowIndex < hoveredLinkRange.end.y || column <= hoveredLinkRange.end.x);
      if (!cell || (!cell.underline && !cell.strikethrough && !cell.overline && !hoveredLink)) {
        continue;
      }
      context.fillStyle = cssColor(cell.foreground);
      const left = padding + column * metrics.width;
      if (cell.underline || hoveredLink) {
        context.fillRect(left, top + metrics.height - 2, metrics.width, 1);
      }
      if (cell.strikethrough) {
        context.fillRect(left, top + Math.floor(metrics.height * 0.55), metrics.width, 1);
      }
      if (cell.overline) context.fillRect(left, top + 1, metrics.width, 1);
    }
  }

  if (cursorOn && snapshot.cursorVisible && snapshot.cursorX >= 0 && snapshot.cursorY >= 0) {
    const left = padding + snapshot.cursorX * metrics.width;
    const top = rowTop(snapshot.cursorY);
    const height = rowTop(snapshot.cursorY + 1) - top;
    const cells = snapshot.rowData[snapshot.cursorY]?.cells ?? [];
    const wide = isWideGlyph(cells, snapshot.cursorX);
    const width = wide ? metrics.width * 2 : metrics.width;
    context.fillStyle = cssColor(snapshot.cursor);
    if (!focused || snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, 2, height);
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + height - 2, width, 2);
    } else {
      const cell = cells[snapshot.cursorX];
      context.fillRect(left, top, width, height);
      if (cell?.text) {
        const powerlineShape = POWERLINE_SHAPES.get(cell.text);
        if (powerlineShape) {
          drawPowerlineShape(
            context,
            powerlineShape,
            cssColor(snapshot.background),
            left,
            top,
            metrics.width,
            height,
            0,
          );
        } else {
          context.fillStyle = cssColor(snapshot.background);
          context.font = fontForCell(cell, fontSize, fontFamily);
          context.textAlign = wide ? "center" : "start";
          context.fillText(
            cell.text,
            wide ? left + metrics.width : left,
            top + metrics.baseline,
            width,
          );
          context.textAlign = "start";
        }
      }
    }
  }
}
