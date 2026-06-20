import { RGBA } from "@opentui/core";
import type { IBufferCell, Terminal } from "@xterm/headless";

/** A cell colour: a truecolor hex string, or an ANSI palette slot the terminal themes itself. */
export type TermColor = string | RGBA;

/** A run of same-styled characters on one terminal row. */
export interface TermSegment {
  readonly text: string;
  readonly color?: TermColor;
  readonly backgroundColor?: TermColor;
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

function cellColor(cell: IBufferCell, foreground: boolean): TermColor | undefined {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  // ANSI palette slot (0–255). Emit an indexed colour so the host terminal
  // renders it with ITS OWN theme — matching the rest of the UI — instead of a
  // baked-in palette that ignores the user's colours.
  return RGBA.fromIndex(value);
}

/** Stable string key for a cell colour (used to coalesce same-styled runs). */
function colorKey(color: TermColor | undefined): string {
  if (color === undefined) return "";
  return typeof color === "string" ? color : `idx${color.slot}`;
}

function styleKey(segment: TermSegment): string {
  return [
    colorKey(segment.color),
    colorKey(segment.backgroundColor),
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

/**
 * The on-screen viewport as plain text — used to copy the terminal to the system
 * clipboard (OSC 52). Trailing blank lines are dropped.
 */
export function readTerminalViewport(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n").replace(/\s*\n+$/u, "");
}
