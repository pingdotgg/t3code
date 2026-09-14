/**
 * omp renders some command output for a terminal, not for a chat bubble:
 * `/context` draws its bars with SGR color codes, and those arrive verbatim
 * in `agent_message_chunk` text. T3 Code renders message text as text, so the
 * escapes show up as `[38;2;107;114;128m` noise around every bar.
 *
 * Stripping happens on the omp path only — no other provider emits terminal
 * escapes — and has to survive streaming: a chunk boundary can fall inside an
 * escape sequence, so a trailing partial sequence is held back until the next
 * chunk completes it (or the turn ends and it is dropped, since a partial
 * escape is not text either).
 */

/**
 * CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), the nF escapes that select a
 * character set (`ESC ( B`), and the two-character escapes. Nothing else
 * appears in omp's output, and a narrow pattern cannot eat real text by
 * accident.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-9;:?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[ -/]+[0-~]|\u001B[@-Z\\-_]/g;

/**
 * A tail that could still become a complete sequence once more text arrives.
 * The OSC branch requires the sequence to be unterminated: a `ESC ]…BEL`
 * that already closed is a complete escape, and treating it as a tail would
 * withhold every character printed after it.
 */
const PARTIAL_ANSI_TAIL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-9;:?]*[ -/]*|\](?:(?!\u0007|\u001B\\)[\s\S])*)?$/;

/** Remove every terminal escape sequence from a complete string. */
export function stripAnsi(text: string): string {
  return text.includes("\u001B") ? text.replace(ANSI_PATTERN, "") : text;
}

export interface AnsiFilter {
  /** Strip escapes from a streamed chunk, holding back a partial tail. */
  readonly push: (text: string) => string;
  /** Emit whatever a completed stream left buffered, minus partial escapes. */
  readonly flush: () => string;
}

/** Streaming stripper: one per assistant stream, cheap to create. */
export function makeAnsiFilter(): AnsiFilter {
  let pending = "";
  return {
    push: (text) => {
      const combined = pending + text;
      const partial = PARTIAL_ANSI_TAIL_PATTERN.exec(combined);
      const boundary = partial === null ? combined.length : partial.index;
      pending = combined.slice(boundary);
      return stripAnsi(combined.slice(0, boundary));
    },
    flush: () => {
      const buffered = pending;
      pending = "";
      return stripAnsi(buffered.replace(PARTIAL_ANSI_TAIL_PATTERN, ""));
    },
  };
}
