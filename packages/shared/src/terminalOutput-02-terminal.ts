
/** Server/client folds must agree: only the last LIVE_LINES are cursor-addressable, with no wrapping.
 * SGR resets at line boundaries for safe tail cuts; unfinished escapes carry through pending. */

export interface TerminalOutputState {
  /** Fixed lines followed by the live window; contains only SGR escapes. */
  readonly text: string;
  readonly truncated: boolean;
  /** An unfinished escape sequence awaiting the next chunk. */
  readonly pending: string;
  readonly screen: TerminalScreen;
}

/** Canonical SGR parameters; empty means default style. */
export interface Run {
  readonly pen: string;
  readonly text: string;
}
export type Line = ReadonlyArray<Run>;

export interface TerminalScreen {
  /** Scrolled-out lines, each ending in newline, as head + tail. Only the tail grows, so a cut
   * usually slices the head instead of copying all scrollback on every chunk. */
  readonly settled: readonly [head: string, tail: string];
  /** Never empty. */
  readonly lines: ReadonlyArray<Line>;
  readonly row: number;
  readonly col: number;
  readonly pen: string;
  readonly saved: { readonly row: number; readonly col: number } | null;
}

export const EMPTY_TERMINAL_OUTPUT: TerminalOutputState = {
  text: "",
  truncated: false,
  pending: "",
  screen: { settled: ["", ""], lines: [[]], row: 0, col: 0, pen: "", saved: null },
};

/** Default command tail, in UTF-16 code units. */
export const TERMINAL_OUTPUT_TAIL_CHARS = 64 * 1024;

export const LIVE_LINES = 64;

export const MAX_PENDING_ESCAPE = 64;

export const ESC = "\u001b";

export function sgr(pen: string): string {
  return pen === "" ? `${ESC}[0m` : `${ESC}[0;${pen}m`;
}

// Lines stay immutable after a feed, so their measured lengths can be cached.
export const lineLengths = new WeakMap<Line, number>();

export function lineLength(line: Line): number {
  const cached = lineLengths.get(line);
  if (cached !== undefined) return cached;
  let length = 0;
  for (const run of line) length += run.text.length;
  lineLengths.set(line, length);
  return length;
}

// Strip oldest styles to bound work on color-per-character output.
export const MAX_LINE_RUNS = 2_048;

export function sliceLine(line: Line, start: number, end: number): Array<Run> {
  const out: Array<Run> = [];
  let offset = 0;
  for (const run of line) {
    const runEnd = offset + run.text.length;
    if (runEnd > start && offset < end) {
      out.push({
        pen: run.pen,
        text: run.text.slice(Math.max(0, start - offset), Math.min(run.text.length, end - offset)),
      });
    }
    offset = runEnd;
    if (offset >= end) break;
  }
  return out;
}

export function pushRun(runs: Array<Run>, run: Run): void {
  if (run.text.length === 0) return;
  const last = runs.at(-1);
  if (last !== undefined && last.pen === run.pen) {
    runs[runs.length - 1] = { pen: last.pen, text: last.text + run.text };
  } else {
    runs.push(run);
  }
}

/** Mutates only lines owned by this feed. */
export function trimLineStart(runs: Array<Run>, count: number): void {
  let dropped = 0;
  let remaining = count;
  while (remaining > 0 && dropped < runs.length) {
    const run = runs[dropped]!;
    if (run.text.length <= remaining) {
      remaining -= run.text.length;
      dropped += 1;
    } else {
      runs[dropped] = { pen: run.pen, text: run.text.slice(remaining) };
      remaining = 0;
    }
  }
  if (dropped > 0) runs.splice(0, dropped);
}

export function writeLine(line: Line, col: number, text: string, pen: string): Line {
  const length = lineLength(line);
  if (col === length) {
    const runs = line.slice();
    pushRun(runs, { pen, text });
    return runs;
  }
  const runs: Array<Run> = [];
  for (const run of sliceLine(line, 0, Math.min(col, length))) pushRun(runs, run);
  if (col > length) pushRun(runs, { pen: "", text: " ".repeat(col - length) });
  pushRun(runs, { pen, text });
  for (const run of sliceLine(line, col + text.length, length)) pushRun(runs, run);
  return runs;
}

/** Erase in line: 0 cursor to end, 1 start to cursor, 2 whole line. */
export function eraseLine(line: Line, col: number, mode: number): Line {
  const length = lineLength(line);
  if (mode === 0) return sliceLine(line, 0, col);
  if (mode === 1) {
    const runs: Array<Run> = [];
    pushRun(runs, { pen: "", text: " ".repeat(Math.min(col + 1, length)) });
    for (const run of sliceLine(line, col + 1, length)) pushRun(runs, run);
    return runs;
  }
  return mode === 2 ? [] : line;
}

export function serializeLine(line: Line): string {
  let out = "";
  let current = "";
  for (const run of line) {
    if (run.pen !== current) {
      out += sgr(run.pen);
      current = run.pen;
    }
    out += run.text;
  }
  return current === "" ? out : out + sgr("");
}

export interface Attributes {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  fg: string;
  bg: string;
}

export function parsePen(pen: string): Attributes {
  const attributes: Attributes = {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    fg: "",
    bg: "",
  };
  if (pen !== "") applySgr(attributes, pen.split(";").map(Number));
  return attributes;
}

export function extendedColor(
  code: number,
  params: ReadonlyArray<number>,
  index: number,
): [string | undefined, number] {
  const mode = params[index + 1];
  if (mode === 5) {
    const value = params[index + 2];
    return value === undefined || value > 255
      ? [undefined, index + 3]
      : [`${code};5;${value}`, index + 3];
  }
  if (mode === 2) {
    const [r, g, b] = [params[index + 2], params[index + 3], params[index + 4]];
    if (r === undefined || g === undefined || b === undefined) return [undefined, index + 5];
    return [`${code};2;${r & 255};${g & 255};${b & 255}`, index + 5];
  }
  return [undefined, index + 2];
}

export function applySgr(attributes: Attributes, params: ReadonlyArray<number>): void {
  if (params.length === 0) params = [0];
  for (let index = 0; index < params.length;) {
    const code = params[index]!;
    if (code === 0 || Number.isNaN(code)) {
      Object.assign(attributes, parsePen(""));
    } else if (code === 1) attributes.bold = true;
    else if (code === 2) attributes.dim = true;
    else if (code === 3) attributes.italic = true;
    else if (code === 4) attributes.underline = true;
    else if (code === 7) attributes.inverse = true;
    else if (code === 9) attributes.strike = true;
    else if (code === 22) attributes.bold = attributes.dim = false;
    else if (code === 23) attributes.italic = false;
    else if (code === 24) attributes.underline = false;
    else if (code === 27) attributes.inverse = false;
    else if (code === 29) attributes.strike = false;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) attributes.fg = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
      attributes.bg = String(code);
    else if (code === 39) attributes.fg = "";
    else if (code === 49) attributes.bg = "";
    else if (code === 38 || code === 48) {
      const [color, next] = extendedColor(code, params, index);
      if (color !== undefined) attributes[code === 38 ? "fg" : "bg"] = color;
      index = next;
      continue;
    }
    index += 1;
  }
}

export interface TerminalSpan {
  readonly text: string;
  readonly style: TerminalSpanStyle | null;
}

export interface TerminalSpanStyle {
  /** CSS colours, already resolved against the palette. */
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly fontWeight?: "600";
  readonly opacity?: number;
  readonly fontStyle?: "italic";
  readonly textDecorationLine?: "underline" | "line-through" | "underline line-through";
}

export type Rgb = readonly [number, number, number];

