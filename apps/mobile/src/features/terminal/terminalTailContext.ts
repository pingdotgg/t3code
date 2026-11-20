import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import {
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type ComposerContextId,
  type TerminalContextRecord,
} from "@t3tools/contracts";

export const ATTACH_TERMINAL_MAX_LINES = 200;

/** The newest lines of captured output as a terminal context record, or null when there is none. */
export function buildTerminalTailContextRecord(input: {
  readonly text: string;
  readonly contextId: ComposerContextId;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly maxLines?: number;
}): TerminalContextRecord | null {
  const lines = input.text.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  if (end === 0) return null;

  const maxLines = input.maxLines ?? ATTACH_TERMINAL_MAX_LINES;
  let start = end;
  // Length of lines[start, end) joined with "\n"; -1 so the first line adds no separator.
  let length = -1;
  while (start > 0 && end - start < maxLines) {
    const next = length + 1 + (lines[start - 1] ?? "").length;
    if (next > COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS) break;
    length = next;
    start -= 1;
  }

  let text: string;
  if (start === end) {
    // The newest line alone is over the limit, so keep its end.
    start = end - 1;
    text = (lines[start] ?? "").slice(-COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS);
  } else {
    text = lines.slice(start, end).join("\n");
  }

  const count = end - start;
  return {
    version: 1,
    kind: "terminal",
    contextId: input.contextId,
    label: m(
      msg("{terminalLabel} · last {count} {value2}", {
        terminalLabel: input.terminalLabel,
        count,
        value2: count === 1 ? "line" : "lines",
      }),
    ),
    terminalId: input.terminalId,
    terminalLabel: input.terminalLabel,
    lineStart: start + 1,
    lineEnd: end,
    text,
  };
}
