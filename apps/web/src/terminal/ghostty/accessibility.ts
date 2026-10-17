import type { GhosttyRow } from "./core";

// Escape sequences (CSI, OSC/DCS/SOS/PM/APC strings, plain ESC) and C0/C1
// controls other than tab, line feed and carriage return. Each terminator is
// captured so a sequence cut off at the end of a chunk can be told apart.
const CONTROL_SEQUENCE =
  // eslint-disable-next-line no-control-regex -- Matching control characters is the point.
  /\x1b(?:\[[0-?]*[ -/]*([@-~])?|[\]PX^_][\s\S]*?(\x07|\x1b\\|$)|[ -/]*([0-~])?)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/** OSC, DCS, SOS, PM, and APC introducers; their strings run until BEL or ST. */
const STRING_OPENERS = ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"];
/** Output beyond this many lines between keystrokes is left for review instead of read aloud. */
const MAX_ANNOUNCED_LINES = 20;
const ANNOUNCE_DELAY_MS = 100;
const TOO_MUCH_OUTPUT = "\nToo much output to announce, read the terminal rows instead.";

/** An SGR sequence after its leading ESC; private-marker CSI ... m sequences are not SGR. */
const SGR_BODY = /^\[([0-9;:]*)m$/;

/** Whether text is concealed (SGR 8) after an SGR parameter list, skipping extended color arguments. */
function sgrConcealed(params: string, concealed: boolean): boolean {
  const values = params.split(";");
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    const code = Number(value.split(":")[0] || 0);
    if (code === 0 || code === 28) concealed = false;
    else if (code === 8) concealed = true;
    else if ((code === 38 || code === 48 || code === 58) && !value.includes(":")) {
      const mode = values[index + 1];
      index += mode === "5" ? 2 : mode === "2" ? 4 : 0;
    }
  }
  return concealed;
}

/**
 * Printable text of PTY output, dropping concealed text the canvas hides. `concealed` is the
 * terminal's state before `data`; an unfinished trailing sequence is returned to prepend to the
 * next chunk.
 */
export function stripTerminalControls(
  data: string,
  concealed = false,
): { text: string; pending: string } {
  let text = "";
  let pending = "";
  let end = 0;
  for (const match of data.matchAll(CONTROL_SEQUENCE)) {
    const [sequence, csiEnd, stringEnd, escEnd] = match;
    if (!concealed) text += data.slice(end, match.index);
    end = match.index + sequence.length;
    if (sequence.startsWith("\x1b") && end === data.length && !(csiEnd || stringEnd || escEnd)) {
      pending = sequence;
    } else {
      const sgr = sequence.startsWith("\x1b") ? SGR_BODY.exec(sequence.slice(1)) : null;
      if (sgr) concealed = sgrConcealed(sgr[1] ?? "", concealed);
    }
  }
  if (!concealed) text += data.slice(end);
  return { text, pending };
}

/** A row's text as the canvas shows it, with concealed cells blanked. */
export function accessibleRowText(row: GhosttyRow): string {
  if (!row.cells.some((cell) => cell.invisible)) return row.text;
  return row.cells
    .map((cell) => (cell.invisible ? " " : cell.text || " "))
    .join("")
    .trimEnd();
}

/** Collapses carriage-return rewrites (progress bars, spinners) to the last visible text per line. */
export function collapseTerminalOverwrites(text: string): string {
  return text
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").findLast(Boolean) ?? "")
    .join("\n");
}

/**
 * Screen reader live region for terminal output, following xterm.js: output is
 * read aloud in short batches, the shell's echo of typed characters is skipped
 * because the screen reader already spoke them, and long bursts stop being
 * read until the next keystroke.
 */
export class TerminalAnnouncer {
  readonly element: HTMLDivElement;
  private pending = "";
  private buffer = "";
  private echo: string[] = [];
  private lines = 0;
  private timer: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "sr-only";
    this.element.setAttribute("aria-live", "polite");
  }

  typed(data: string): void {
    this.element.textContent = "";
    this.lines = 0;
    // Control keys (Enter, arrows) produce output the screen reader has not spoken.
    if ([...data].length === 1 && data >= " " && data !== "\x7f") this.echo.push(data);
    else this.echo = [];
  }

  /**
   * `concealed` comes from the terminal core before it parses `data`, so muted,
   * capped, or replayed output can never leave this out of step with the canvas.
   */
  output(data: string, concealed: boolean): void {
    if (this.lines > MAX_ANNOUNCED_LINES) {
      this.skip(data);
      return;
    }
    const { text, pending } = stripTerminalControls(this.pending + data, concealed);
    this.pending = pending;
    for (const char of text) {
      // Only a match consumes a typed character: a line redraw (\r, prompt)
      // can precede the echo itself.
      if (this.echo[0] === char) {
        this.echo.shift();
        continue;
      }
      this.buffer += char;
      if (char === "\n" && ++this.lines > MAX_ANNOUNCED_LINES) {
        this.buffer += TOO_MUCH_OUTPUT;
        break;
      }
    }
    if (this.buffer.length > 0 && this.timer === null) {
      // Empty the region for the whole batch delay so a batch identical to the
      // last one still registers as a change and is announced again.
      this.element.textContent = "";
      this.timer = window.setTimeout(this.flush, ANNOUNCE_DELAY_MS);
    }
  }

  /**
   * Output the core parses without announcing. Only an unfinished trailing sequence is
   * kept, because the core holds it too and the next announced chunk completes it.
   */
  skip(data: string): void {
    const joined = this.pending + data;
    // A string sequence is open only if the last opener has no terminator after it. Native
    // searches keep this cheap: a full parse costs ~14x more on unannounced output.
    const opener = Math.max(...STRING_OPENERS.map((value) => joined.lastIndexOf(value)));
    if (opener >= 0 && !joined.includes("\x07", opener) && !joined.includes("\x1b\\", opener)) {
      this.pending = joined.slice(opener);
      return;
    }
    const start = joined.lastIndexOf("\x1b");
    this.pending = start < 0 ? "" : stripTerminalControls(joined.slice(start)).pending;
  }

  /** The core was reset and replayed `data` without announcing it. */
  replay(data: string): void {
    this.reset();
    this.pending = "";
    this.skip(data);
  }

  /** Stops announcing; the unfinished-sequence carry stays in step with the core. */
  reset(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.element.textContent = "";
    this.buffer = "";
    this.echo = [];
    this.lines = 0;
  }

  private readonly flush = () => {
    this.timer = null;
    const text = collapseTerminalOverwrites(this.buffer);
    this.buffer = "";
    if (text.trim().length > 0) this.element.textContent = text;
  };
}
