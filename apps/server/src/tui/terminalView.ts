import type { IBufferCell, Terminal } from "@xterm/headless";

/** A run of same-styled characters on one terminal row. */
export interface TermSegment {
  readonly text: string;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}

export interface TermFrame {
  readonly rows: ReadonlyArray<ReadonlyArray<TermSegment>>;
  readonly cursor: { readonly x: number; readonly y: number };
}

// Standard xterm 256-colour palette as hex, precomputed once.
const ANSI_256: string[] = (() => {
  const base16 = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;
  const table: string[] = [...base16];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    table.push(rgb(levels[Math.floor(i / 36) % 6]!, levels[Math.floor(i / 6) % 6]!, levels[i % 6]!));
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table.push(rgb(v, v, v));
  }
  return table;
})();

function cellColor(cell: IBufferCell, foreground: boolean): string | undefined {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  return ANSI_256[value];
}

function styleKey(segment: TermSegment): string {
  return [
    segment.color ?? "",
    segment.backgroundColor ?? "",
    segment.bold ? "b" : "",
    segment.dimColor ? "d" : "",
    segment.italic ? "i" : "",
    segment.underline ? "u" : "",
    segment.inverse ? "v" : "",
  ].join("|");
}

function cellStyle(cell: IBufferCell): Omit<TermSegment, "text"> {
  const color = cellColor(cell, true);
  const backgroundColor = cellColor(cell, false);
  return {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(cell.isBold() ? { bold: true } : {}),
    ...(cell.isDim() ? { dimColor: true } : {}),
    ...(cell.isItalic() ? { italic: true } : {}),
    ...(cell.isUnderline() ? { underline: true } : {}),
    ...(cell.isInverse() ? { inverse: true } : {}),
  };
}

/**
 * Read the visible viewport of an xterm headless terminal into styled rows that
 * Ink can render — runs of same-styled cells are coalesced into segments, and
 * the cursor cell is emitted inverted.
 */
export function readTerminalFrame(term: Terminal): TermFrame {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const cursor = { x: buffer.cursorX, y: buffer.cursorY };
  const rows: TermSegment[][] = [];

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    const segments: TermSegment[] = [];
    if (!line) {
      rows.push(segments);
      continue;
    }
    let runText = "";
    let runStyle: Omit<TermSegment, "text"> = {};
    let runKey: string | null = null;
    const flush = () => {
      if (runKey !== null && runText.length > 0) segments.push({ text: runText, ...runStyle });
    };
    for (let x = 0; x < term.cols; x++) {
      const got = line.getCell(x, cell);
      if (!got) continue;
      if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
      const chars = cell.getChars() || " ";
      const isCursor = y === cursor.y && x === cursor.x;
      const baseStyle = cellStyle(cell);
      const style: Omit<TermSegment, "text"> = isCursor
        ? { ...baseStyle, inverse: !baseStyle.inverse }
        : baseStyle;
      // The cursor cell gets a unique key ("@") so it never merges with neighbours.
      const key = `${styleKey({ text: "", ...style })}${isCursor ? "@" : ""}`;
      if (key === runKey) {
        runText += chars;
      } else {
        flush();
        runText = chars;
        runStyle = style;
        runKey = key;
      }
    }
    flush();
    rows.push(segments);
  }

  return { rows, cursor };
}
