// Rendered markdown files above this stay in the virtualized source viewer.
export const LARGE_MARKDOWN_RENDER_MAX_BYTES = 32 * 1024 * 1024;
const CHUNK_TARGET_CHARS = 16 * 1024;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|\r?$)/;
// A column-0 paragraph, quote or table after a blank line closes any open list, quote or table.
const BLOCK_START = /^[\p{L}\p{N}`[!|>]/u;
const ORDERED_ITEM = /^\d{1,9}[.)](?:[ \t]|\r?$)/;

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
  let fence: string | null = null;
  let afterBlankLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence !== null) {
      const closer = FENCE_OPEN.exec(line)?.[1];
      if (
        closer &&
        closer[0] === fence[0] &&
        closer.length >= fence.length &&
        !line.trim().slice(closer.length)
      )
        fence = null;
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
      fence = FENCE_OPEN.exec(line)?.[1] ?? null;
    }
    chars += line.length + 1;
    afterBlankLine = line.trim() === "";
  }
  chunks.push({ text: lines.slice(start).join("\n"), lines: lines.length - start });
  return chunks;
}
