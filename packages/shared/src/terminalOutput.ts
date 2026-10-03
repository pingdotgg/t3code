/**
 * Turns raw terminal bytes (already decoded to text) into a bounded, plain
 * tail that a timeline can show. Runs on the server before output crosses the
 * wire, and again on clients when they splice appends onto what they hold.
 *
 * - ANSI/VT escape sequences (colours, cursor moves, OSC titles) are removed.
 * - `\r\n` is a newline; a lone `\r` rewinds the current line, so progress
 *   bars keep only their latest frame.
 * - Backspace erases one character; other control characters are dropped.
 * - Only the last `maxChars` survive, cut at a line boundary when possible.
 *
 * Chunks can split an escape sequence or a `\r\n` pair, so the unfinished
 * fragment is carried in `pending` until the next chunk arrives.
 */
export interface TerminalOutputState {
  /** Settled lines plus the current (still mutable) last line. */
  readonly text: string;
  /** True once anything was dropped from the front. */
  readonly truncated: boolean;
  /** An unfinished escape sequence or trailing `\r` awaiting the next chunk. */
  readonly pending: string;
}

export const EMPTY_TERMINAL_OUTPUT: TerminalOutputState = {
  text: "",
  truncated: false,
  pending: "",
};

/** The default tail kept for one running command, in UTF-16 code units. */
export const TERMINAL_OUTPUT_TAIL_CHARS = 64 * 1024;

// Longest fragment we will hold waiting for an escape sequence to finish.
const MAX_PENDING_ESCAPE = 64;

/** Keeps the last `maxChars`, preferring to start on a fresh line. */
export function terminalOutputTail(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let tail = text.slice(text.length - maxChars);
  const newline = tail.indexOf("\n");
  // Drop the partial first line unless that would discard most of the tail.
  if (newline !== -1 && newline < maxChars / 4) tail = tail.slice(newline + 1);
  // Never start on a lone low surrogate.
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return { text: tail, truncated: true };
}

/** Length of a complete escape sequence starting at `index` (an ESC), or -1 if unfinished. */
function escapeLength(input: string, index: number): number {
  const next = input[index + 1];
  if (next === undefined) return -1;
  if (next === "[") {
    // CSI: parameters/intermediates, then a final byte in @-~.
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      const code = input.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
    }
    return -1;
  }
  if (next === "]" || next === "P" || next === "_" || next === "^") {
    // OSC/DCS/APC/PM end at BEL or ST (ESC \).
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      if (input[cursor] === "\u0007") return cursor - index + 1;
      if (input[cursor] === "\u001b") {
        if (cursor + 1 >= input.length) return -1;
        if (input[cursor + 1] === "\\") return cursor - index + 2;
      }
    }
    return -1;
  }
  // Two-byte sequences (ESC 7, ESC =, ESC ( B takes three).
  if (next === "(" || next === ")" || next === "*" || next === "+") {
    return index + 2 < input.length ? 3 : -1;
  }
  return 2;
}

/** Appends one decoded chunk and returns the new bounded state. */
export function appendTerminalOutput(
  state: TerminalOutputState,
  chunk: string,
  maxChars: number = TERMINAL_OUTPUT_TAIL_CHARS,
): TerminalOutputState {
  const input = state.pending + chunk;
  if (input.length === 0) return state;
  const lastNewline = state.text.lastIndexOf("\n");
  // Settled lines never change again; only the current line is rewritten.
  const settled = state.text.slice(0, lastNewline + 1);
  let line = state.text.slice(lastNewline + 1);
  const out: Array<string> = [settled];
  let pending = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const code = character.charCodeAt(0);
    if (character === "\n") {
      out.push(line, "\n");
      line = "";
      continue;
    }
    if (character === "\r") {
      if (index + 1 >= input.length) {
        pending = "\r";
        break;
      }
      if (input[index + 1] === "\n") continue;
      line = "";
      continue;
    }
    if (character === "\u001b") {
      const length = escapeLength(input, index);
      if (length === -1) {
        const fragment = input.slice(index);
        // A runaway unterminated sequence is noise; drop it instead of waiting forever.
        if (fragment.length <= MAX_PENDING_ESCAPE) pending = fragment;
        break;
      }
      index += length - 1;
      continue;
    }
    if (character === "\b") {
      line = line.slice(0, -1);
      continue;
    }
    if (character === "\t") {
      line += character;
      continue;
    }
    // C0 controls, DEL and C1 controls carry no visible text.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    line += character;
  }
  out.push(line);
  const tail = terminalOutputTail(out.join(""), maxChars);
  return { text: tail.text, truncated: state.truncated || tail.truncated, pending };
}

/** Normalizes a complete output string in one pass. */
export function normalizeTerminalOutput(
  text: string,
  maxChars: number = TERMINAL_OUTPUT_TAIL_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, text, maxChars);
  // A trailing `\r` at the very end of a finished stream is just a line end.
  return { text: state.text, truncated: state.truncated };
}
