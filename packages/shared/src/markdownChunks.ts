// Rendered markdown files above this stay in the virtualized source viewer.
export const LARGE_MARKDOWN_RENDER_MAX_BYTES = 32 * 1024 * 1024;
const CHUNK_TARGET_CHARS = 16 * 1024;
// A chunk past this (one huge fence or HTML block) is too slow to parse at once; show source.
export const LARGE_MARKDOWN_CHUNK_MAX_CHARS = 128 * 1024;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|\r?$)/;
// A column-0 paragraph, quote or table after a blank line closes any open list, quote or table.
const BLOCK_START = /^[\p{L}\p{N}`[!|>]/u;
const ORDERED_ITEM = /^\d{1,9}[.)](?:[ \t]|\r?$)/;
// CommonMark HTML blocks of types 1-5 and display math run past blank lines until their closer.
const SPANNING_BLOCKS: ReadonlyArray<readonly [open: RegExp, close: RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}\$\$/, /\$\$/],
];

const HTML_BLOCK_START = /^ {0,3}<\/?[A-Za-z]/;

/** Returns how to recognize the end of a block that `line` opens, or null for none. */
function blockCloser(line: string): ((line: string) => boolean) | null {
  const fence = FENCE_OPEN.exec(line)?.[1];
  if (fence) {
    return (next) => {
      const closer = FENCE_OPEN.exec(next)?.[1];
      return (
        closer !== undefined &&
        closer[0] === fence[0] &&
        closer.length >= fence.length &&
        !next.trim().slice(closer.length)
      );
    };
  }
  for (const [open, close] of SPANNING_BLOCKS) {
    const opener = open.exec(line)?.[0];
    if (opener === undefined) continue;
    return close.test(line.slice(opener.length)) ? null : (next) => close.test(next);
  }
  // Other HTML blocks (CommonMark types 6 and 7) run until a blank line.
  return HTML_BLOCK_START.test(line) ? (next) => next.trim() === "" : null;
}

export interface MarkdownChunk {
  readonly text: string;
  readonly lines: number;
}

/**
 * Cuts Markdown too large to parse at once into pieces of roughly `targetChars`, only at
 * column-0 headings or paragraphs that start a new top-level block. Definitions and footnotes
 * resolve only inside their own piece, and duplicate heading slugs restart per piece.
 */
export function splitLargeMarkdown(
  text: string,
  targetChars = CHUNK_TARGET_CHARS,
): MarkdownChunk[] {
  const lines = text.split("\n");
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let chars = 0;
  let closes: ((line: string) => boolean) | null = null;
  let afterBlankLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (closes !== null) {
      if (closes(line)) closes = null;
    } else {
      const cut =
        chars >= targetChars &&
        (ATX_HEADING.test(line) ||
          (afterBlankLine && BLOCK_START.test(line) && !ORDERED_ITEM.test(line)));
      if (cut) {
        chunks.push({ text: lines.slice(start, index).join("\n"), lines: index - start });
        start = index;
        chars = 0;
      }
      closes = blockCloser(line);
    }
    chars += line.length + 1;
    afterBlankLine = line.trim() === "";
  }
  chunks.push({ text: lines.slice(start).join("\n"), lines: lines.length - start });
  return chunks;
}
