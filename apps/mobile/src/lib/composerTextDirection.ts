import {
  hasRightToLeftLetter,
  markdownProseDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";

export type ComposerLineDirection = TextDirection | "";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A closing fence carries no info string.
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// The paragraph breaks Foundation's paragraphRange uses, so entries line up with the iOS editor.
const PARAGRAPH_BREAK = /\r\n|[\n\r\u0085\u2029]/;

/**
 * One entry per line, as the web composer does per block: a line follows its own word
 * majority, a line without letters continues the one above, and fenced code stays left to
 * right. Empty without a right-to-left letter, leaving native first-strong layout alone.
 */
export function composerLineDirections(text: string): ReadonlyArray<ComposerLineDirection> {
  if (!hasRightToLeftLetter(text)) return [];
  let fence: string | undefined;
  let previous: ComposerLineDirection = "";
  return text.split(PARAGRAPH_BREAK).map((line) => {
    if (fence === undefined) {
      fence = FENCE.exec(line)?.[1];
      if (fence !== undefined) return "ltr";
    } else {
      const marker = CLOSING_FENCE.exec(line)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return "ltr";
    }
    previous = markdownProseDirection(line) ?? previous;
    return previous;
  });
}

/** A single-direction editor can only override first-strong when every line agrees. */
export function composerUniformDirection(
  lines: ReadonlyArray<ComposerLineDirection>,
): ComposerLineDirection {
  const directions = new Set(lines.filter((line) => line !== ""));
  return directions.size === 1 ? [...directions][0]! : "";
}
