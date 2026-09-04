import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttyScreenTheme,
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

type TerminalBlockRect = readonly [x: number, y: number, width: number, height: number];

const DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)";

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

export function ghosttyTextRunEnd(
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
    if (next.text.length === 0 || !sameStyle(next)) break;
    end += 1;
  }
  return end;
}

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const style = cell.italic ? "italic" : "normal";
  const weight = cell.bold ? "700" : "400";
  return `${style} ${weight} ${fontSize}px ${fontFamily}`;
}

/** Solid Unicode block elements render as cell geometry, without font side-bearing seams. */
function terminalBlockRects(text: string): readonly TerminalBlockRect[] | null {
  const lower = (eighths: number): readonly TerminalBlockRect[] => [
    [0, 1 - eighths / 8, 1, eighths / 8],
  ];
  const left = (eighths: number): readonly TerminalBlockRect[] => [[0, 0, eighths / 8, 1]];
  switch (text) {
    case "▀":
      return [[0, 0, 1, 0.5]];
    case "▁":
    case "▂":
    case "▃":
    case "▄":
    case "▅":
    case "▆":
    case "▇":
      return lower(text.codePointAt(0)! - 0x2580);
    case "█":
      return [[0, 0, 1, 1]];
    case "▉":
    case "▊":
    case "▋":
    case "▌":
    case "▍":
    case "▎":
    case "▏":
      return left(0x2590 - text.codePointAt(0)!);
    case "▐":
      return [[0.5, 0, 0.5, 1]];
    case "▔":
      return [[0, 0, 1, 0.125]];
    case "▕":
      return [[0.875, 0, 0.125, 1]];
    case "▖":
      return [[0, 0.5, 0.5, 0.5]];
    case "▗":
      return [[0.5, 0.5, 0.5, 0.5]];
    case "▘":
      return [[0, 0, 0.5, 0.5]];
    case "▙":
      return [
        [0, 0, 0.5, 1],
        [0.5, 0.5, 0.5, 0.5],
      ];
    case "▚":
      return [
        [0, 0, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ];
    case "▛":
      return [
        [0, 0, 1, 0.5],
        [0, 0.5, 0.5, 0.5],
      ];
    case "▜":
      return [
        [0, 0, 1, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ];
    case "▝":
      return [[0.5, 0, 0.5, 0.5]];
    case "▞":
      return [
        [0.5, 0, 0.5, 0.5],
        [0, 0.5, 0.5, 0.5],
      ];
    case "▟":
      return [
        [0.5, 0, 0.5, 1],
        [0, 0.5, 0.5, 0.5],
      ];
    default:
      return null;
  }
}

/** Rounds a block fraction to whole pixels, keeping thin edges at least one pixel wide inside the cell. */
function blockPixelSpan(
  origin: number,
  start: number,
  length: number,
  size: number,
): readonly [from: number, to: number] {
  let from = Math.round(start * size);
  let to = Math.round((start + length) * size);
  if (to <= from) {
    if (to >= size) from = to - 1;
    else to = from + 1;
  }
  return [origin + from, origin + to];
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
    // libghostty's cell and mouse APIs use integer logical pixels. Flooring
    // also makes CanvasRenderingContext2D condense text into the same grid,
    // keeping glyphs, backgrounds, and mouse hit targets aligned.
    width: Math.max(1, Math.floor(widthMeasurement.width)),
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
  /** Remap only terminal-default colors; explicit ANSI application colors win. */
  readonly defaultThemeOverride?: {
    readonly source: GhosttyScreenTheme;
    readonly target: GhosttyScreenTheme;
  };
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  /** Vertical origin of row 0; defaults to the horizontal padding. */
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
  const themeOverride = options.defaultThemeOverride;
  const defaultBackground = themeOverride?.target.background ?? snapshot.background;
  const defaultForeground = themeOverride?.target.foreground ?? snapshot.foreground;
  const resolveDefaultColor = (
    color: GhosttyColor,
    sourceDefault: GhosttyColor,
    sourceInverse: GhosttyColor,
    targetDefault: GhosttyColor,
    targetInverse: GhosttyColor,
  ) => {
    if (!themeOverride) return color;
    if (ghosttyColorsEqual(color, sourceDefault)) return targetDefault;
    if (ghosttyColorsEqual(color, sourceInverse)) return targetInverse;
    return color;
  };
  const resolveBackground = (color: GhosttyColor) =>
    resolveDefaultColor(
      color,
      themeOverride?.source.background ?? snapshot.background,
      themeOverride?.source.foreground ?? snapshot.foreground,
      defaultBackground,
      defaultForeground,
    );
  const resolveForeground = (color: GhosttyColor) =>
    resolveDefaultColor(
      color,
      themeOverride?.source.foreground ?? snapshot.foreground,
      themeOverride?.source.background ?? snapshot.background,
      defaultForeground,
      defaultBackground,
    );
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
    context.fillStyle = cssColor(defaultBackground);
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  context.textBaseline = "alphabetic";
  for (const rowIndex of rowsToDraw) {
    const row = snapshot.rowData[rowIndex];
    if (!row) continue;
    const top = originY + rowIndex * metrics.height;

    context.fillStyle = cssColor(defaultBackground);
    context.fillRect(padding, top, snapshot.cols * metrics.width, metrics.height);

    let backgroundStart = 0;
    while (backgroundStart < row.cells.length) {
      const first = row.cells[backgroundStart];
      if (!first) break;
      const firstBackground = resolveBackground(first.background);
      let backgroundEnd = backgroundStart + 1;
      while (backgroundEnd < row.cells.length) {
        const next = row.cells[backgroundEnd];
        if (
          !next ||
          next.selected !== first.selected ||
          !ghosttyColorsEqual(resolveBackground(next.background), firstBackground)
        ) {
          break;
        }
        backgroundEnd += 1;
      }
      if (first.selected || !ghosttyColorsEqual(firstBackground, defaultBackground)) {
        const left = padding + backgroundStart * metrics.width;
        const width = (backgroundEnd - backgroundStart) * metrics.width;
        if (!ghosttyColorsEqual(firstBackground, defaultBackground)) {
          context.fillStyle = cssColor(firstBackground);
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
      const blockRects = terminalBlockRects(first.text);
      if (blockRects !== null) {
        if (!first.invisible) {
          context.fillStyle = cssColor(resolveForeground(first.foreground));
          const cellLeft = padding + runStart * metrics.width;
          for (const [x, y, width, height] of blockRects) {
            const [left, right] = blockPixelSpan(cellLeft, x, width, metrics.width);
            const [rectTop, bottom] = blockPixelSpan(top, y, height, metrics.height);
            context.fillRect(left, rectTop, right - left, bottom - rectTop);
          }
        }
        runStart += 1;
        continue;
      }
      const runEnd = ghosttyTextRunEnd(
        row.cells,
        runStart,
        (cell) => terminalBlockRects(cell.text) === null && sameTextStyle(cell, first),
      );
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
        context.fillStyle = cssColor(resolveForeground(first.foreground));
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
      context.fillStyle = cssColor(resolveForeground(cell.foreground));
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
    const cursor =
      themeOverride && ghosttyColorsEqual(snapshot.cursor, themeOverride.source.cursor)
        ? themeOverride.target.cursor
        : snapshot.cursor;
    context.fillStyle = cssColor(cursor);
    if (!focused) {
      // An unfocused terminal draws a hollow cursor so the active pane is obvious.
      context.strokeStyle = cssColor(cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, 2, metrics.height);
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + metrics.height - 2, metrics.width, 2);
    } else if (snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else {
      context.fillRect(left, top, metrics.width, metrics.height);
      const cell = snapshot.rowData[snapshot.cursorY]?.cells[snapshot.cursorX];
      if (cell?.text) {
        context.font = fontForCell(cell, fontSize, fontFamily);
        context.fillStyle = cssColor(defaultBackground);
        context.fillText(cell.text, left, top + metrics.baseline, metrics.width);
      }
    }
  }
}
