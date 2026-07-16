import { RGBA } from "@opentui/core";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolveWrappedTerminalLinkRange,
} from "@t3tools/shared/terminalLinks";
import type { IBufferCell, Terminal } from "@xterm/headless";

import { indexedColor } from "./theme.ts";

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
  /** Terminal-native OSC 8 hyperlink emitted for detected HTTP(S) output. */
  readonly href?: string;
}

export interface TermFrame {
  readonly rows: ReadonlyArray<ReadonlyArray<TermSegment>>;
  readonly cursor: { readonly x: number; readonly y: number };
  /** Lines of scrollback above the live viewport (the clamp ceiling for scrolling). */
  readonly maxScroll: number;
  /** The offset actually rendered (the requested offset clamped to `[0, maxScroll]`). */
  readonly scrollOffset: number;
}

/** Avoid rescanning pathological multi-megabyte logical lines on every repaint. */
const TERMINAL_LINK_SCAN_MAX_CHARS = 64 * 1024;
/** Keep OSC 8 payloads bounded even when terminal output contains a hostile URL. */
const TERMINAL_LINK_MAX_CHARS = 4 * 1024;

function cellColor(cell: IBufferCell, foreground: boolean): TermColor | undefined {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  // ANSI palette slot (0–255). Use the detected-palette snapshot so the cell
  // renders with the user's terminal theme (matching the rest of the UI) instead
  // of OpenTUI's baked-in palette when compositing on our transparent background.
  return indexedColor(value);
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
    segment.href ?? "",
  ].join("|");
}

interface TermRowLink {
  readonly start: number;
  readonly end: number;
  readonly href: string;
}

/** Resolve wrapped HTTP(S) matches to zero-based cell ranges in the visible frame. */
function terminalUrlRanges(
  term: Terminal,
  top: number,
): ReadonlyMap<number, ReadonlyArray<TermRowLink>> {
  const buffer = term.buffer.active;
  const byRow = new Map<number, TermRowLink[]>();
  const processedBufferRows = new Set<number>();
  const firstVisibleBufferLine = top + 1;
  const lastVisibleBufferLine = top + term.rows;

  for (let row = 0; row < term.rows; row++) {
    const bufferLineNumber = firstVisibleBufferLine + row;
    if (processedBufferRows.has(bufferLineNumber)) continue;
    const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (index) =>
      buffer.getLine(index),
    );
    if (!wrappedLine) continue;
    for (const segment of wrappedLine.segments) {
      processedBufferRows.add(segment.bufferLineNumber);
    }
    if (wrappedLine.text.length > TERMINAL_LINK_SCAN_MAX_CHARS) continue;

    for (const match of extractTerminalLinks(wrappedLine.text)) {
      if (match.kind !== "url" || match.text.length > TERMINAL_LINK_MAX_CHARS) continue;
      const range = resolveWrappedTerminalLinkRange(wrappedLine, match);
      const startRow = Math.max(range.start.y, firstVisibleBufferLine);
      const endRow = Math.min(range.end.y, lastVisibleBufferLine);
      for (let line = startRow; line <= endRow; line++) {
        const visibleRow = line - firstVisibleBufferLine;
        const links = byRow.get(visibleRow) ?? [];
        links.push({
          start: line === range.start.y ? range.start.x - 1 : 0,
          end: line === range.end.y ? range.end.x : term.cols,
          href: match.text,
        });
        byRow.set(visibleRow, links);
      }
    }
  }

  return byRow;
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
export function readTerminalFrame(term: Terminal, scrollOffset = 0): TermFrame {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  // `baseY` is the top row of the LIVE viewport (== scrollback length). Scrolling
  // up renders from `baseY - offset`; offset 0 is the live tail. Clamp so a stale
  // offset (buffer trimmed to its scrollback cap) can't read a negative row.
  const maxScroll = buffer.baseY;
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const top = maxScroll - offset;
  // The cursor only belongs to the live tail; hide it while viewing history so a
  // stray inverted cell doesn't appear over old output.
  const cursor = offset === 0 ? { x: buffer.cursorX, y: buffer.cursorY } : { x: -1, y: -1 };
  const rows: TermSegment[][] = [];
  const urlRanges = terminalUrlRanges(term, top);

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(top + y);
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
      const href = urlRanges.get(y)?.find((link) => link.start <= x && x < link.end)?.href;
      const linkedStyle = href ? { ...baseStyle, href } : baseStyle;
      const style: Omit<TermSegment, "text"> = isCursor
        ? { ...linkedStyle, inverse: !linkedStyle.inverse }
        : linkedStyle;
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

  return { rows, cursor, maxScroll, scrollOffset: offset };
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

/**
 * Encode clipboard text for forwarding to a PTY, honouring the running program's
 * bracketed-paste mode.
 *
 * Security: when bracketed paste is active the text is framed with the real
 * `ESC [ 200 ~` / `ESC [ 201 ~` introducers, and any embedded end-of-paste
 * marker is stripped first. Without that strip a crafted clipboard payload
 * containing `ESC [ 201 ~` would close paste mode early, so the bytes after it
 * reach the shell as if typed — a bracketed-paste injection that can run
 * arbitrary commands from a single paste. Both the 7-bit `ESC [ 201 ~` and the
 * 8-bit C1 `0x9b 201 ~` forms are neutralised.
 */
export function encodeTerminalPaste(text: string, bracketedPasteMode: boolean): string {
  if (!bracketedPasteMode) return text;
  const guarded = text.replace(/\x1b\[201~/g, "").replace(/\x9b201~/g, "");
  return `\x1b[200~${guarded}\x1b[201~`;
}
