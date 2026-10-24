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
const POWERLINE_SOLID_RIGHT = "\ue0b0";
const POWERLINE_SOLID_LEFT = "\ue0b2";
const POWERLINE_ROUND_RIGHT = "\ue0b4";
const POWERLINE_ROUND_LEFT = "\ue0b6";
const POWERLINE_FIRST = 0xe0b0;
const POWERLINE_LAST = 0xe0d7;
// Cubic control offset that approximates a quarter circle.
const QUARTER_CIRCLE_KAPPA = ((Math.SQRT2 - 1) * 4) / 3;

function cssColor(color: GhosttyColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  // Selection deliberately does not participate: it only tints the background
  // overlay, and splitting a text run at a selection boundary visibly shifts
  // glyph spacing whenever the face's true advance differs from the cell width.
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  );
}

function isSolidPowerlineSeparator(text: string): boolean {
  return (
    text === POWERLINE_SOLID_RIGHT ||
    text === POWERLINE_SOLID_LEFT ||
    text === POWERLINE_ROUND_RIGHT ||
    text === POWERLINE_ROUND_LEFT
  );
}

// Fallback fonts inset or scale these private-use glyphs, leaving a gap where
// the separator should meet the next cell. Fill the shape from the cell's own
// edges instead, as native terminals do.
function fillSolidPowerlineSeparator(
  context: CanvasRenderingContext2D,
  text: string,
  cellLeft: number,
  top: number,
  metrics: GhosttyCellMetrics,
): void {
  // Columns start at fractional x. Growing the shape out to whole pixels
  // makes it overlap its neighbors instead of leaving an antialiased seam.
  // Snap in device pixels so fractional display scales get the same edge.
  const scale = context.getTransform().a;
  const left = Math.floor(cellLeft * scale) / scale;
  const right = Math.ceil((cellLeft + metrics.width) * scale) / scale;
  const bottom = top + metrics.height;
  const pointsRight = text === POWERLINE_SOLID_RIGHT || text === POWERLINE_ROUND_RIGHT;
  const base = pointsRight ? left : right;
  context.beginPath();
  context.moveTo(base, top);
  if (text === POWERLINE_ROUND_RIGHT || text === POWERLINE_ROUND_LEFT) {
    // Ghostty's half circle: radius min(width, height / 2), with a straight
    // edge between the arcs when the cell is taller than it is wide.
    const radius = Math.min(right - left, metrics.height / 2);
    const edge = base + (pointsRight ? radius : -radius);
    const control = base + (pointsRight ? radius : -radius) * QUARTER_CIRCLE_KAPPA;
    const inset = radius * (1 - QUARTER_CIRCLE_KAPPA);
    context.bezierCurveTo(control, top, edge, top + inset, edge, top + radius);
    context.lineTo(edge, bottom - radius);
    context.bezierCurveTo(edge, bottom - inset, control, bottom, base, bottom);
  } else {
    context.lineTo(pointsRight ? right : left, top + metrics.height / 2);
    context.lineTo(base, bottom);
  }
  context.closePath();
  context.fill();
}

// Nerd Font icons live in the Private Use Areas.
function isNerdFontIcon(text: string): boolean {
  const codePoint = text.codePointAt(0) ?? 0;
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000;
}

// Icons are often wider than a cell. Like Ghostty, let one spread into a
// following blank cell and shrink it to fit whatever room it has, so it never
// spills under its neighbors.
function fillNerdFontIcon(
  context: CanvasRenderingContext2D,
  cells: readonly GhosttyCell[],
  column: number,
  left: number,
  top: number,
  metrics: GhosttyCellMetrics,
): void {
  const text = cells[column]?.text ?? "";
  const next = cells[column + 1];
  const previous = cells[column - 1];
  const previousCodePoint = previous?.text.codePointAt(0) ?? 0;
  const previousIsIcon =
    previous !== undefined &&
    isNerdFontIcon(previous.text) &&
    (previousCodePoint < POWERLINE_FIRST || previousCodePoint > POWERLINE_LAST);
  const span = next && next.text.trim().length === 0 && !previousIsIcon ? 2 : 1;
  const room = span * metrics.width;
  const glyph = context.measureText(text);
  const inkLeft = -glyph.actualBoundingBoxLeft;
  const inkWidth = glyph.actualBoundingBoxLeft + glyph.actualBoundingBoxRight;
  const inkHeight = glyph.actualBoundingBoxAscent + glyph.actualBoundingBoxDescent;
  const scale = Math.min(1, room / inkWidth, metrics.height / inkHeight);
  context.save();
  context.beginPath();
  context.rect(left, top, room, metrics.height);
  context.clip();
  if (scale < 1 || inkLeft < 0 || inkLeft + inkWidth > room) {
    const inkCenterOffset = (glyph.actualBoundingBoxAscent - glyph.actualBoundingBoxDescent) / 2;
    context.translate(left + room / 2, top + metrics.height / 2);
    context.scale(scale, scale);
    context.fillText(text, -inkLeft - inkWidth / 2, inkCenterOffset);
  } else {
    context.fillText(text, left, top + metrics.baseline);
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
    if (
      next.text.length === 0 ||
      isSolidPowerlineSeparator(next.text) ||
      isNerdFontIcon(next.text) ||
      !sameStyle(next)
    ) {
      break;
    }
    end += 1;
  }
  return end;
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
    const top = originY + rowIndex * metrics.height;

    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(padding, top, snapshot.cols * metrics.width, metrics.height);

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
          context.fillRect(left, top, width, metrics.height);
        }
        if (first.selected) {
          context.fillStyle = selectionBackground;
          context.fillRect(left, top, width, metrics.height);
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
      if (isSolidPowerlineSeparator(first.text)) {
        if (!first.invisible) {
          context.fillStyle = cssColor(first.foreground);
          fillSolidPowerlineSeparator(
            context,
            first.text,
            padding + runStart * metrics.width,
            top,
            metrics,
          );
        }
        runStart += 1;
        continue;
      }
      if (isNerdFontIcon(first.text)) {
        if (!first.invisible) {
          context.font = fontForCell(first, fontSize, fontFamily);
          context.fillStyle = cssColor(first.foreground);
          fillNerdFontIcon(
            context,
            row.cells,
            runStart,
            padding + runStart * metrics.width,
            top,
            metrics,
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
          metrics.height,
        );
        context.clip();
        context.font = fontForCell(first, fontSize, fontFamily);
        context.fillStyle = cssColor(first.foreground);
        context.fillText(
          text,
          padding + runStart * metrics.width,
          top + metrics.baseline,
          (runEnd - runStart) * metrics.width,
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
    const top = originY + snapshot.cursorY * metrics.height;
    context.fillStyle = cssColor(snapshot.cursor);
    if (!focused) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, 2, metrics.height);
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + metrics.height - 2, metrics.width, 2);
    } else if (snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else {
      context.fillRect(left, top, metrics.width, metrics.height);
      const cell = snapshot.rowData[snapshot.cursorY]?.cells[snapshot.cursorX];
      if (cell?.text) {
        context.fillStyle = cssColor(snapshot.background);
        if (isSolidPowerlineSeparator(cell.text)) {
          fillSolidPowerlineSeparator(context, cell.text, left, top, metrics);
        } else {
          context.font = fontForCell(cell, fontSize, fontFamily);
          context.fillText(cell.text, left, top + metrics.baseline, metrics.width);
        }
      }
    }
  }
}
