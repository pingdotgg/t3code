// Rendered markdown files above this stay in the virtualized source viewer.
export const LARGE_MARKDOWN_RENDER_MAX_BYTES = 64 * 1024 * 1024;
// About one screen of rendered Markdown; parsing costs up to ~40 ms per KB with tables and math.
const CHUNK_TARGET_CHARS = 4 * 1024;
// Past two chunks, rendered previews split the document and parse it lazily.
export const CHUNKED_MARKDOWN_MIN_CHARS = 2 * CHUNK_TARGET_CHARS;
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

// A tag name, not an autolink such as <https://example.com>.
const HTML_BLOCK_START = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)/;

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

const FRONTMATTER_OPEN = /^\uFEFF?---[ \t]*\r?$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
// An opening rule with no closer is a thematic break, not frontmatter; stop waiting for one.
const FRONTMATTER_MAX_LINES = 1000;

/**
 * Cuts Markdown into pieces of roughly `targetChars` as its text arrives, only at column-0
 * headings or paragraphs that start a new top-level block. Leading frontmatter stays in the
 * first piece. Definitions and footnotes resolve only inside their own piece, and duplicate
 * heading slugs restart per piece.
 */
export function createMarkdownSplitter(targetChars = CHUNK_TARGET_CHARS) {
  let lines: string[] = [];
  let partial = "";
  let first = true;
  let chars = 0;
  let closes: ((line: string) => boolean) | null = null;
  let afterBlankLine = false;
  const flush = (done: MarkdownChunk[]) => {
    done.push({ text: lines.join("\n"), lines: lines.length });
    lines = [];
    chars = 0;
  };
  const add = (line: string, done: MarkdownChunk[]) => {
    if (closes !== null) {
      if (closes(line)) closes = null;
    } else if (first && FRONTMATTER_OPEN.test(line)) {
      let seen = 0;
      closes = (next) => FRONTMATTER_CLOSE.test(next) || ++seen >= FRONTMATTER_MAX_LINES;
    } else {
      const cut =
        chars >= targetChars &&
        (ATX_HEADING.test(line) ||
          (afterBlankLine && BLOCK_START.test(line) && !ORDERED_ITEM.test(line)));
      if (cut) flush(done);
      closes = blockCloser(line);
    }
    first = false;
    lines.push(line);
    chars += line.length + 1;
    afterBlankLine = line.trim() === "";
  };
  return {
    /** Adds text and returns the pieces it completed. */
    push(text: string): MarkdownChunk[] {
      const done: MarkdownChunk[] = [];
      const parts = (partial + text).split("\n");
      partial = parts.pop()!;
      for (const line of parts) add(line, done);
      return done;
    },
    /** Returns the last piece once the text has ended. */
    end(): MarkdownChunk[] {
      const done: MarkdownChunk[] = [];
      add(partial, done);
      partial = "";
      flush(done);
      return done;
    },
  };
}

export function splitLargeMarkdown(
  text: string,
  targetChars = CHUNK_TARGET_CHARS,
): MarkdownChunk[] {
  const splitter = createMarkdownSplitter(targetChars);
  return [...splitter.push(text), ...splitter.end()];
}
