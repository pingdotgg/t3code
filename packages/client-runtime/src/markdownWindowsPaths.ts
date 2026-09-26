/**
 * CommonMark reads a backslash before ASCII punctuation as an escape, even
 * inside a link or image destination. Agents write Windows paths with their
 * native separator, so `C:\Users\dara\.t3\shot.png` parses as
 * `C:\Users\dara.t3\shot.png` and the asset request asks for a file that does
 * not exist. Rewriting the separators to `/` before parsing keeps every
 * character in place: the path is still absolute, the parser has nothing to
 * unescape, and the text keeps its length so source offsets stay valid.
 */

// Inline destinations after `](` and reference definitions such as `[id]: C:\...`.
// A definition, like a fence, can sit inside block quotes and list items.
const DESTINATION_START_PATTERN =
  /(?:\]\(\s*|^(?:(?: {0,3}(?:> ?|(?:[-+*]|\d{1,9}[.)])(?: |$)))*) {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*(?:\n[ \t]*)?)(<?)([A-Za-z]:[\\/])/gm;
// A backslash before a parenthesis is an escape the parser needs; rewriting it
// would leave the parenthesis unbalanced and break the link entirely.
const SEPARATOR_PATTERN = /\\(?![()])/g;
// A code span opens and closes with backtick runs of the same length. A run
// next to another backtick is part of a longer run, and a backslash before the
// opening run escapes its first backtick, unless that backslash is itself
// escaped, so only an odd run of backslashes counts. Escapes are inert inside
// a span, so a backslash before the closing run does not. A span cannot cross
// a blank line, since that ends the paragraph.
const INLINE_CODE_PATTERN =
  /(?<!`)(?<!(?<!\\)(?:\\\\)*\\)(`+)[^`](?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
// A fence can sit inside block quotes and list items at any nesting depth, so
// any indentation is accepted before the fence run. A fence-looking line that
// is really indented code is code either way; the loop below ends it where
// the indented block ends.
const CODE_FENCE_PATTERN =
  /^(?:(?: {0,3}(?:> ?|(?:[-+*]|\d{1,9}[.)])(?: |$)))*)\s*(`{3,}|~{3,})(.*)$/;

/**
 * Length of a bare destination starting at `start`, honoring balanced
 * parentheses. With `escapes` on, a backslash before a parenthesis hides it
 * from the balance, which is how the parser reads the text as written.
 */
function bareDestination(
  text: string,
  start: number,
  escapes: boolean,
): { readonly length: number; readonly balanced: boolean } {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") break;
    if (escapes && char === "\\" && (text[index + 1] === "(" || text[index + 1] === ")")) {
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  return { length: index - start, balanced: depth === 0 };
}

function normalizeDestinations(segment: string): string {
  if (!segment.includes("\\")) return segment;
  let result = "";
  let cursor = 0;
  for (const match of segment.matchAll(DESTINATION_START_PATTERN)) {
    const angle = match[1] === "<";
    const start = match.index + match[0].length - 3;
    if (start < cursor) continue;
    let length: number;
    let separators = SEPARATOR_PATTERN;
    if (angle) {
      const end = segment.indexOf(">", start);
      const lineEnd = segment.indexOf("\n", start);
      if (end < 0 || (lineEnd >= 0 && lineEnd < end)) continue;
      length = end - start;
      // Parentheses need no escaping inside angle brackets.
      separators = /\\/g;
    } else {
      // A backslash before a parenthesis is a separator when reading it that
      // way still yields a balanced destination that the link can close after,
      // which repairs `\(old)\` segments the parser would otherwise cut short.
      // Otherwise it stays an escape, so a link that renders today keeps
      // rendering with the same extent.
      const escaped = bareDestination(segment, start, true);
      const literal = bareDestination(segment, start, false);
      const afterLiteral = segment[start + literal.length];
      const afterEscapedClose = segment[start + escaped.length + 1];
      // The escaped reading is bogus when the `)` it stops at is followed by
      // more path text or another `)`, since that `)` cannot then be the
      // link's own closer.
      const escapedCutShort =
        segment[start + escaped.length] === ")" &&
        afterEscapedClose !== undefined &&
        !/\s/.test(afterEscapedClose);
      const useLiteral =
        literal.balanced &&
        (literal.length === escaped.length ||
          (escapedCutShort &&
            afterLiteral !== undefined &&
            (afterLiteral === ")" || /\s/.test(afterLiteral))));
      length = useLiteral ? literal.length : escaped.length;
      if (useLiteral) separators = /\\/g;
    }
    result += segment.slice(cursor, start);
    result += segment.slice(start, start + length).replace(separators, "/");
    cursor = start + length;
  }
  return result + segment.slice(cursor);
}

function normalizeOutsideInlineCode(segment: string): string {
  let result = "";
  let cursor = 0;
  for (const match of segment.matchAll(INLINE_CODE_PATTERN)) {
    result += normalizeDestinations(segment.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + normalizeDestinations(segment.slice(cursor));
}

/**
 * Rewrites Windows drive-letter link and image destinations to forward slashes
 * so backslash escapes cannot corrupt the path during parsing. Code spans and
 * fenced code blocks are left as written. The result has the same length as
 * the input.
 */
export function normalizeWindowsMarkdownDestinations(markdown: string): string {
  if (!markdown.includes("\\")) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let openFence: string | null = null;

  const flushProse = () => {
    if (prose.length === 0) return;
    output.push(normalizeOutsideInlineCode(prose.join("\n")));
    prose = [];
  };

  let fenceInQuote = false;
  let fenceColumn = 0;

  for (const line of lines) {
    const match = CODE_FENCE_PATTERN.exec(line);
    const fence = match?.[1];
    const info = match?.[2] ?? "";
    if (openFence === null) {
      // A backtick fence cannot carry a backtick in its info string.
      if (fence !== undefined && !(fence[0] === "`" && info.includes("`"))) {
        flushProse();
        openFence = fence;
        fenceInQuote = /^ {0,3}>/.test(line);
        // Only a fence inside a list item or an indented block has a container
        // to end; an ordinary fence may sit up to three spaces in and still
        // hold unindented content.
        const column = line.indexOf(fence);
        fenceColumn = column >= 4 || /^ {0,3}(?:[-+*]|\d{1,9}[.)]) /.test(line) ? column : 0;
        output.push(line);
      } else {
        prose.push(line);
      }
      continue;
    }
    // A fence opened inside a block quote ends with the quote, and an indented
    // fence ends with its list item or indented code block: the first non-blank
    // line that sits left of the fence run is outside that container.
    const indent = line.length - line.trimStart().length;
    if (
      (fenceInQuote && !/^ {0,3}>/.test(line)) ||
      (!fenceInQuote && fenceColumn > 0 && indent < fenceColumn && line.trim() !== "")
    ) {
      openFence = null;
      prose.push(line);
      continue;
    }
    output.push(line);
    if (
      fence !== undefined &&
      fence[0] === openFence[0] &&
      fence.length >= openFence.length &&
      info.trim() === ""
    ) {
      openFence = null;
    }
  }
  flushProse();
  return output.join("\n");
}
