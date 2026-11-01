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
interface Run {
  readonly pen: string;
  readonly text: string;
}
type Line = ReadonlyArray<Run>;

interface TerminalScreen {
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

const LIVE_LINES = 64;

const MAX_PENDING_ESCAPE = 64;

const ESC = "\u001b";

function sgr(pen: string): string {
  return pen === "" ? `${ESC}[0m` : `${ESC}[0;${pen}m`;
}

// Lines stay immutable after a feed, so their measured lengths can be cached.
const lineLengths = new WeakMap<Line, number>();

function lineLength(line: Line): number {
  const cached = lineLengths.get(line);
  if (cached !== undefined) return cached;
  let length = 0;
  for (const run of line) length += run.text.length;
  lineLengths.set(line, length);
  return length;
}

// Strip oldest styles to bound work on color-per-character output.
const MAX_LINE_RUNS = 2_048;

function sliceLine(line: Line, start: number, end: number): Array<Run> {
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

function pushRun(runs: Array<Run>, run: Run): void {
  if (run.text.length === 0) return;
  const last = runs.at(-1);
  if (last !== undefined && last.pen === run.pen) {
    runs[runs.length - 1] = { pen: last.pen, text: last.text + run.text };
  } else {
    runs.push(run);
  }
}

/** Mutates only lines owned by this feed. */
function trimLineStart(runs: Array<Run>, count: number): void {
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

function writeLine(line: Line, col: number, text: string, pen: string): Line {
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
function eraseLine(line: Line, col: number, mode: number): Line {
  const length = lineLength(line);
  if (mode === 0) return sliceLine(line, 0, col);
  if (mode === 1) {
    const runs: Array<Run> = [];
    pushRun(runs, { pen: "", text: " ".repeat(Math.min(col + 1, length)) });
    for (const run of sliceLine(line, col + 1, length)) pushRun(runs, run);
    return runs;
  }
  return [];
}

function serializeLine(line: Line): string {
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

interface Attributes {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  fg: string;
  bg: string;
}

function parsePen(pen: string): Attributes {
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

function formatPen(attributes: Attributes): string {
  const parts: Array<string> = [];
  if (attributes.bold) parts.push("1");
  if (attributes.dim) parts.push("2");
  if (attributes.italic) parts.push("3");
  if (attributes.underline) parts.push("4");
  if (attributes.inverse) parts.push("7");
  if (attributes.strike) parts.push("9");
  if (attributes.fg !== "") parts.push(attributes.fg);
  if (attributes.bg !== "") parts.push(attributes.bg);
  return parts.join(";");
}

/** Reads 5;n or 2;r;g;b colors; returns the code and next index. */
function extendedColor(
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

function applySgr(attributes: Attributes, params: ReadonlyArray<number>): void {
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

const STRING_SEQUENCE_INTRODUCERS = new Set(["]", "P", "X", "_", "^"]);

/** Length of a complete escape sequence starting at `index` (an ESC), or -1 if unfinished. */
function escapeLength(input: string, index: number): number {
  const next = input[index + 1];
  if (next === undefined) return -1;
  if (next === "[") {
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      const code = input.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
    }
    return -1;
  }
  if (STRING_SEQUENCE_INTRODUCERS.has(next)) {
    // BEL/ST ends string sequences; also stop at newlines so stray binary introducers cannot hide later output.
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      if (input[cursor] === "\u0007") return cursor - index + 1;
      if (input[cursor] === "\n") return cursor - index;
      if (input[cursor] === ESC) {
        if (cursor + 1 >= input.length) return -1;
        if (input[cursor + 1] === "\\") return cursor - index + 2;
      }
    }
    return -1;
  }
  // Charset designations take three bytes; other sequences take two.
  if (next === "(" || next === ")" || next === "*" || next === "+") {
    return index + 2 < input.length ? 3 : -1;
  }
  return 2;
}

const penTransitions = new Map<string, string>();

// Colon color sub-parameters carry an optional color-space id absent from the semicolon form.
function csiParams(params: string): Array<number> {
  const numbers: Array<number> = [];
  for (const part of params.split(";")) {
    if (!part.includes(":")) {
      numbers.push(Number(part));
      continue;
    }
    const sub = part.split(":").map(Number);
    if ((sub[0] === 38 || sub[0] === 48) && sub[1] === 2 && sub.length >= 6) sub.splice(2, 1);
    numbers.push(...sub);
  }
  return numbers;
}

class Terminal {
  settledHead: string;
  settledTail: string;
  lines: Array<Line>;
  row: number;
  col: number;
  pen: string;
  saved: { row: number; col: number } | null;
  /** Output was discarded on purpose (scrollback cleared or window over budget). */
  dropped = false;
  readonly maxChars: number;
  /** Lines created during this feed, which it may extend in place. */
  private readonly owned = new WeakSet<Line>();

  constructor(screen: TerminalScreen, maxChars: number) {
    this.maxChars = maxChars;
    [this.settledHead, this.settledTail] = screen.settled;
    this.lines = screen.lines.slice();
    this.row = screen.row;
    this.col = screen.col;
    this.pen = screen.pen;
    this.saved = screen.saved;
  }

  write(text: string): void {
    let line = this.lines[this.row]!;
    const length = lineLength(line);
    if (this.col === length && this.owned.has(line)) {
      pushRun(line as Array<Run>, { pen: this.pen, text });
      lineLengths.set(line, length + text.length);
    } else {
      line = writeLine(line, this.col, text, this.pen);
      this.owned.add(line);
    }
    this.col += text.length;
    if (line.length > MAX_LINE_RUNS) {
      // Flatten old runs so later trimming stays cheap.
      const keep = line.length - MAX_LINE_RUNS / 8;
      const plain = line
        .slice(0, keep)
        .map((run) => run.text)
        .join("");
      line = [{ pen: "", text: plain }, ...line.slice(keep)];
      this.owned.add(line);
    }
    // Trim each write to maxChars columns so results do not depend on chunk boundaries.
    let current = lineLength(line);
    if (current > this.maxChars) {
      let removed = current - this.maxChars;
      if (!this.owned.has(line)) {
        line = line.slice();
        this.owned.add(line);
      }
      trimLineStart(line as Array<Run>, removed);
      // Never start on a lone low surrogate.
      const first = line[0]?.text.charCodeAt(0) ?? 0;
      if (first >= 0xdc00 && first <= 0xdfff) {
        trimLineStart(line as Array<Run>, 1);
        removed += 1;
      }
      current -= removed;
      this.dropped = true;
      this.col = Math.max(0, this.col - removed);
      if (this.saved !== null && this.saved.row === this.row) {
        this.saved = { ...this.saved, col: Math.max(0, this.saved.col - removed) };
      }
    }
    lineLengths.set(line, current);
    this.lines[this.row] = line;
  }

  newline(): void {
    this.row += 1;
    this.col = 0;
    if (this.row === this.lines.length) this.lines.push([]);
    while (this.lines.length > LIVE_LINES) this.scrollOut();
  }

  scrollOut(): number {
    const line = this.lines.shift()!;
    this.settle(line);
    this.row -= 1;
    if (this.saved !== null) this.saved = { ...this.saved, row: Math.max(0, this.saved.row - 1) };
    return lineLength(line);
  }

  settle(line: Line): void {
    this.settledTail += `${serializeLine(line)}\n`;
    if (this.settledHead.length + this.settledTail.length > 2 * this.maxChars) {
      [this.settledHead, this.settledTail = ""] = terminalOutputTailParts(
        [this.settledHead, this.settledTail],
        this.maxChars,
      ).parts;
      this.dropped = true;
    }
  }

  moveTo(row: number, col: number): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, row));
    // A huge column (ESC[999999999C) would otherwise pad a line past any string limit.
    this.col = Math.max(0, Math.min(TERMINAL_OUTPUT_TAIL_CHARS, col));
  }

  csi(params: string, final: string): void {
    if (/^[?>=]/u.test(params)) return; // Mode switches (cursor visibility, bracketed paste).
    if (final === "m") {
      const key = `${this.pen}|${params}`;
      let pen = penTransitions.get(key);
      if (pen === undefined) {
        const attributes = parsePen(this.pen);
        applySgr(attributes, params === "" ? [] : csiParams(params));
        pen = formatPen(attributes);
        if (penTransitions.size >= 512) penTransitions.clear();
        penTransitions.set(key, pen);
      }
      this.pen = pen;
      return;
    }
    const numbers = params === "" ? [] : csiParams(params);
    const count = Math.max(1, numbers[0] || 1);
    switch (final) {
      case "A":
        return this.moveTo(this.row - count, this.col);
      case "B":
        return this.moveTo(this.row + count, this.col);
      case "C":
        return this.moveTo(this.row, this.col + count);
      case "D":
        return this.moveTo(this.row, this.col - count);
      case "E":
        return this.moveTo(this.row + count, 0);
      case "F":
        return this.moveTo(this.row - count, 0);
      case "G":
        return this.moveTo(this.row, count - 1);
      case "H":
      case "f":
        // Rows count from the top of the window: there is no fixed screen height.
        return this.moveTo(count - 1, Math.max(1, numbers[1] || 1) - 1);
      case "K":
        this.lines[this.row] = eraseLine(this.lines[this.row]!, this.col, numbers[0] ?? 0);
        return;
      case "J": {
        const mode = numbers[0] ?? 0;
        if (mode === 0) {
          this.lines[this.row] = eraseLine(this.lines[this.row]!, this.col, 0);
          this.lines.length = this.row + 1;
        } else if (mode === 1) {
          for (let row = 0; row < this.row; row += 1) this.lines[row] = [];
          this.lines[this.row] = eraseLine(this.lines[this.row]!, this.col, 1);
        } else if (mode === 3) {
          if (this.settledHead !== "" || this.settledTail !== "") this.dropped = true;
          this.settledHead = "";
          this.settledTail = "";
        } else {
          this.lines = [[]];
          this.row = 0;
          this.col = 0;
        }
        return;
      }
      case "s":
        this.saved = { row: this.row, col: this.col };
        return;
      case "u":
        if (this.saved !== null) this.moveTo(this.saved.row, this.saved.col);
        return;
      default:
    }
  }

  escape(sequence: string): void {
    if (sequence[1] === "[") {
      this.csi(sequence.slice(2, -1), sequence.at(-1)!);
    } else if (sequence === `${ESC}7`) {
      this.saved = { row: this.row, col: this.col };
    } else if (sequence === `${ESC}8`) {
      if (this.saved !== null) this.moveTo(this.saved.row, this.saved.col);
    } else if (sequence === `${ESC}M`) {
      this.moveTo(this.row - 1, this.col);
    }
  }

  /** Applies `input`; returns the unfinished escape left at its end. */
  feed(input: string): string {
    let printable = 0;
    const flush = (end: number) => {
      if (end > printable) this.write(input.slice(printable, end));
    };
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code === 0x09 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f))) {
        continue;
      }
      flush(index);
      printable = index + 1;
      if (code === 0x0a) this.newline();
      else if (code === 0x0d) this.col = 0;
      else if (code === 0x08) this.col = Math.max(0, this.col - 1);
      else if (code === 0x1b) {
        const length = escapeLength(input, index);
        if (length === -1) {
          const fragment = input.slice(index);
          if (fragment.length <= MAX_PENDING_ESCAPE) return fragment;
          // Retain the introducer and possible ST prefix so long string payloads stay hidden until termination.
          if (STRING_SEQUENCE_INTRODUCERS.has(fragment[1]!)) {
            return fragment.slice(0, 2) + (fragment.endsWith(ESC) ? ESC : "");
          }
          return "";
        }
        this.escape(input.slice(index, index + length));
        index += length - 1;
        printable = index + 1;
      }
    }
    flush(input.length);
    return "";
  }
}

/** The active style at `index` of `text` and where a cut there may safely start. */
function styleAt(text: string, index: number): { readonly start: number; readonly prefix: string } {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let prefix = "";
  let cursor = lineStart;
  while (cursor < index) {
    const found = text.indexOf(`${ESC}[`, cursor);
    if (found === -1 || found >= index) break;
    const end = text.indexOf("m", found);
    if (end === -1) break;
    if (end >= index) return { start: end + 1, prefix: text.slice(found, end + 1) };
    prefix = text.slice(found, end + 1);
    cursor = end + 1;
  }
  return { start: index, prefix: prefix === sgr("") ? "" : prefix };
}

/** Keeps the last `maxChars`, preferring to start on a fresh line. */
export function terminalOutputTail(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let start = text.length - maxChars;
  const newline = text.indexOf("\n", start);
  // Drop the partial first line unless that would discard most of the tail.
  if (newline !== -1 && newline - start < maxChars / 4) {
    return { text: text.slice(newline + 1), truncated: true };
  }
  // Cutting inside a line: never split an escape, and keep the colour in force.
  const style = styleAt(text, start);
  start = style.start;
  // Never start on a lone low surrogate.
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return { text: style.prefix + text.slice(start), truncated: true };
}

/**
 * terminalOutputTail of the parts' concatenation, kept as parts. V8 copies a concatenated string
 * the first time it is searched or sliced, so a newline cut slices only the part it lands in.
 */
function terminalOutputTailParts(
  parts: readonly [string, ...Array<string>],
  maxChars: number,
): { readonly parts: readonly [string, ...Array<string>]; readonly truncated: boolean } {
  let total = 0;
  for (const part of parts) total += part.length;
  if (total <= maxChars) return { parts, truncated: false };
  const start = total - maxChars;
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (offset + part.length > start) {
      const newline = part.indexOf("\n", Math.max(0, start - offset));
      if (newline !== -1) {
        if (offset + newline - start >= maxChars / 4) break;
        return { parts: [part.slice(newline + 1), ...parts.slice(index + 1)], truncated: true };
      }
    }
    offset += part.length;
  }
  return { parts: [terminalOutputTail(parts.join(""), maxChars).text], truncated: true };
}

export function appendTerminalOutput(
  state: TerminalOutputState,
  chunk: string,
  maxChars: number = TERMINAL_OUTPUT_TAIL_CHARS,
): TerminalOutputState {
  const input = state.pending + chunk;
  if (input.length === 0) return state;
  const terminal = new Terminal(state.screen, maxChars);
  const pending = terminal.feed(input);
  let truncated = state.truncated;
  let windowChars = terminal.lines.reduce((total, line) => total + lineLength(line), 0);
  while (windowChars > maxChars && terminal.row > 0) windowChars -= terminal.scrollOut();
  // Lines below a cursor that moved up can't scroll out; they keep only their ends.
  if (windowChars > maxChars) {
    let budget = maxChars;
    for (let row = 0; row <= terminal.row; row += 1) budget -= lineLength(terminal.lines[row]!);
    for (let row = terminal.row + 1; row < terminal.lines.length; row += 1) {
      const line = terminal.lines[row]!;
      const length = lineLength(line);
      const keep = Math.max(0, Math.min(length, budget));
      if (keep < length) {
        truncated = true;
        terminal.lines[row] = sliceLine(line, length - keep, length);
        if (terminal.saved !== null && terminal.saved.row === row) {
          terminal.saved = {
            ...terminal.saved,
            col: Math.max(0, terminal.saved.col - (length - keep)),
          };
        }
      }
      budget -= keep;
    }
  }
  if (terminal.dropped) truncated = true;
  const settled = terminalOutputTailParts([terminal.settledHead, terminal.settledTail], maxChars);
  const window = terminal.lines.map(serializeLine).join("\n");
  const tail = terminalOutputTailParts([...settled.parts, window], maxChars);
  return {
    text: tail.parts.reduce((text, part) => text + part, ""),
    truncated: truncated || settled.truncated || tail.truncated,
    pending,
    screen: {
      settled: [settled.parts[0], settled.parts[1] ?? ""],
      lines: terminal.lines,
      row: terminal.row,
      col: terminal.col,
      pen: terminal.pen,
      saved: terminal.saved,
    },
  };
}

/** Rebuilds state from empty, including cursor/style/pending escapes, so later raw chunks fold identically. */
export function terminalOutputResumeText(state: TerminalOutputState): string {
  const { screen } = state;
  const lastRow = screen.lines.length - 1;
  // Moves are relative to the last line, and a viewer only holds the lines in `text`.
  let reachable = 0;
  let cursor = 0;
  while (reachable < LIVE_LINES - 1) {
    const newline = state.text.indexOf("\n", cursor);
    if (newline === -1) break;
    reachable += 1;
    cursor = newline + 1;
  }
  const up = (row: number) => Math.min(lastRow - row, reachable);
  const goTo = (row: number, col: number) =>
    (up(row) > 0 ? `${ESC}[${up(row)}A` : "") + `${ESC}[${col + 1}G`;
  let suffix = "";
  if (screen.saved !== null) {
    suffix += `${goTo(screen.saved.row, screen.saved.col)}${ESC}7`;
    if (up(screen.saved.row) > 0) suffix += `${ESC}[${up(screen.saved.row)}B`;
  }
  if (
    screen.saved !== null ||
    screen.row < lastRow ||
    screen.col !== lineLength(screen.lines[screen.row]!)
  ) {
    suffix += goTo(screen.row, screen.col);
  }
  if (screen.pen !== "") suffix += sgr(screen.pen);
  return state.text + suffix + state.pending;
}

export function normalizeTerminalOutput(
  text: string,
  maxChars: number = TERMINAL_OUTPUT_TAIL_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, text, maxChars);
  return { text: state.text, truncated: state.truncated };
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

export const TERMINAL_PALETTES = {
  dark: [
    "#3b4048",
    "#f47067",
    "#57ab5a",
    "#c69026",
    "#539bf5",
    "#b083f0",
    "#39c5cf",
    "#adbac7",
    "#768390",
    "#ff938a",
    "#6bc46d",
    "#daaa3f",
    "#6cb6ff",
    "#dcbdfb",
    "#56d4dd",
    "#cdd9e5",
  ],
  light: [
    "#24292f",
    "#cf222e",
    "#116329",
    "#7d4e00",
    "#0550ae",
    "#8250df",
    "#1b7c83",
    "#6e7781",
    "#57606a",
    "#a40e26",
    "#1a7f37",
    "#633c01",
    "#0969da",
    "#6639ba",
    "#3192aa",
    "#8c959f",
  ],
} as const;

function xtermColor(index: number, palette: ReadonlyArray<string>): string {
  if (index < 16) return palette[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const cube = index - 16;
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${channel(Math.floor(cube / 36))},${channel(Math.floor(cube / 6) % 6)},${channel(cube % 6)})`;
}

function resolveColor(
  code: string,
  base: number,
  palette: ReadonlyArray<string>,
): string | undefined {
  const parts = code.split(";").map(Number);
  const head = parts[0]!;
  if (head === base + 8) {
    if (parts[1] === 5) return xtermColor(parts[2]!, palette);
    return `rgb(${parts[2]},${parts[3]},${parts[4]})`;
  }
  if (head >= base && head <= base + 7) return palette[head - base];
  if (head >= base + 60 && head <= base + 67) return palette[head - base - 52];
  return undefined;
}

type Rgb = readonly [number, number, number];

function parseCssColor(color: string): Rgb | undefined {
  if (color.startsWith("#") && color.length === 7) {
    return [1, 3, 5].map((offset) =>
      Number.parseInt(color.slice(offset, offset + 2), 16),
    ) as unknown as Rgb;
  }
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/u.exec(color);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function spanStyle(pen: string, palette: ReadonlyArray<string>): TerminalSpanStyle | null {
  if (pen === "") return null;
  const attributes = parsePen(pen);
  let color = attributes.fg === "" ? undefined : resolveColor(attributes.fg, 30, palette);
  let backgroundColor = attributes.bg === "" ? undefined : resolveColor(attributes.bg, 40, palette);
  if (attributes.inverse) {
    [color, backgroundColor] = [backgroundColor, color ?? palette[7]];
  }
  // Badges like "PASS" on green assume a terminal's own palette; keep their text readable.
  if (backgroundColor !== undefined) {
    const background = parseCssColor(backgroundColor);
    const foreground = color === undefined ? undefined : parseCssColor(color);
    if (
      background !== undefined &&
      (foreground === undefined || contrastRatio(foreground, background) < 3)
    ) {
      color = luminance(background) > 0.35 ? "#1f2328" : "#ffffff";
    }
  }
  const textDecorationLine = attributes.underline
    ? attributes.strike
      ? "underline line-through"
      : "underline"
    : attributes.strike
      ? "line-through"
      : undefined;
  return {
    ...(color === undefined ? {} : { color }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(attributes.bold ? { fontWeight: "600" } : {}),
    ...(attributes.dim ? { opacity: 0.65 } : {}),
    ...(attributes.italic ? { fontStyle: "italic" } : {}),
    ...(textDecorationLine === undefined ? {} : { textDecorationLine }),
  };
}

/** Caps styled spans at maxSpans, then emits one plain remainder to bound DOM/native nodes. */
export function terminalOutputSpans(
  text: string,
  palette: ReadonlyArray<string>,
  maxSpans = 2_000,
): ReadonlyArray<TerminalSpan> {
  const spans: Array<TerminalSpan> = [];
  const styles = new Map<string, TerminalSpanStyle | null>();
  let pen = "";
  let cursor = 0;
  const push = (end: number) => {
    if (end <= cursor) return;
    let style = styles.get(pen);
    if (style === undefined) {
      style = spanStyle(pen, palette);
      styles.set(pen, style);
    }
    spans.push({ text: text.slice(cursor, end), style });
  };
  while (cursor < text.length) {
    const escape = text.indexOf(`${ESC}[`, cursor);
    if (escape === -1 || spans.length >= maxSpans) break;
    push(escape);
    const end = text.indexOf("m", escape);
    if (end === -1) break;
    const params = text.slice(escape + 2, end);
    pen = params === "0" ? "" : params.replace(/^0;/u, "");
    cursor = end + 1;
  }
  if (cursor < text.length) {
    if (spans.length >= maxSpans) {
      spans.push({ text: terminalOutputPlainText(text.slice(cursor)), style: null });
    } else {
      push(text.length);
    }
  }
  return spans;
}

const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");

export function terminalOutputPlainText(text: string): string {
  return text.replace(SGR_PATTERN, "");
}
