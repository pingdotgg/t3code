export type RichTextMark = "bold" | "italic" | "strike" | "code";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** A run of `text` from `start` to `end` that parses with `marks`. */
interface SourcePiece {
  start: number;
  end: number;
  marks: RichTextMark[];
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

// Brackets, quotes, commas, and Markdown delimiters end a URL or path token; a lone `~` does not.
const PATH_TOKEN = /(?:[\p{L}\p{N}_/.:@%+=&?#-]|(?<!~)~(?!~))+/gu;
const FILE_EXTENSION = /^\.[a-z][a-z0-9]*(?::\d+){0,2}$/i;
// `_yes_/_no_`: each side of a slash is its own emphasis span, so the word is not a path.
const EMPHASIS_ALTERNATIVES = /^_[^/]+_(?:\/_[^/]+_)+$/;

/**
 * Starts of underscore runs that belong to a URL, path, or filename, not to emphasis.
 * A run ending the token stays a delimiter so emphasis wrapped around the token still closes.
 */
function literalUnderscoreRuns(text: string): Set<number> {
  const literal = new Set<number>();
  if (!text.includes("_")) return literal;
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[0];
    let bodyEnd = token.length;
    while (bodyEnd > 0 && ".:?".includes(token[bodyEnd - 1]!)) bodyEnd -= 1;
    if (EMPHASIS_ALTERNATIVES.test(token.slice(0, bodyEnd))) continue;
    while (bodyEnd > 0 && token[bodyEnd - 1] === "_") bodyEnd -= 1;
    const body = token.slice(0, bodyEnd);
    // A slash alone is prose (`and/_or_`); a path also has a dot, a scheme or port, or a root.
    const isPath = body.includes("/")
      ? /^~?\/|[.:]/.test(body)
      : FILE_EXTENSION.test(body.slice(body.lastIndexOf(".")));
    if (!isPath) continue;
    let closesInside = false;
    let start = body.indexOf("_");
    while (start !== -1) {
      let end = start;
      while (body[end] === "_") end += 1;
      if (start > 0) {
        literal.add(match.index + start);
        closesInside ||= !/\w/.test(body[end]!);
      }
      start = body.indexOf("_", end);
    }
    // A leading run could only pair with a run inside the name, as in `__init__.py`.
    if (closesInside && body[0] === "_") literal.add(match.index);
  }
  return literal;
}

// Pieces keep source offsets, so callers can map parsed text back onto the
// characters it came from; parsing only drops delimiters.
function parseInlineMarkdownPieces(text: string): SourcePiece[] {
  const literalRuns = literalUnderscoreRuns(text);
  const root: SourcePiece[] = [];
  const stack: { delimiter: string; mark: RichTextMark; start: number; pieces: SourcePiece[] }[] =
    [];
  const push = (start: number, end: number, marks: RichTextMark[] = []) => {
    if (end <= start) return;
    const pieces = stack.at(-1)?.pieces ?? root;
    const last = pieces.at(-1);
    if (last?.end === start && sameMarks(last.marks, marks)) last.end = end;
    else pieces.push({ start, end, marks });
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      push(index, Math.min(index + 2, text.length));
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = text.slice(index).match(/^`+/)![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        push(index + 1, close, ["code"]);
        index = close + 1;
      } else {
        push(index, index + run.length);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      push(index, index + 1);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    if (literalRuns.has(index)) {
      push(index, end);
      index = end;
      continue;
    }
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const piece of top.pieces) push(piece.start, piece.end, [top.mark, ...piece.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // Prevent self-nesting, including alternate delimiters, to bound the stack by supported styles.
        if (stack.some((frame) => frame.mark === mark)) {
          push(index, end);
          index = end;
          continue;
        }
        stack.push({ delimiter: char.repeat(length), mark, start: index, pieces: [] });
        index += length;
      } else {
        push(index, end);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    push(frame.start, frame.start + frame.delimiter.length);
    for (const piece of frame.pieces) push(piece.start, piece.end, piece.marks);
  }
  return root;
}

export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  for (const { start, end, marks } of parseInlineMarkdownPieces(text)) {
    const last = spans.at(-1);
    if (last && sameMarks(last.marks, marks)) {
      last.text += text.slice(start, end);
    } else {
      spans.push({ text: text.slice(start, end), marks });
    }
  }
  return spans;
}

/** Marks text the composer shows as editable Markdown source while the caret is in it. */
export const MARKDOWN_SOURCE_MARK = "markdownSource";

/** Marks for each UTF-16 unit of `text`, or null for a delimiter that parsing drops. */
export function inlineMarkdownUnitMarks(text: string): Array<RichTextMark[] | null> {
  const result: Array<RichTextMark[] | null> = Array.from({ length: text.length }, () => null);
  for (const { start, end, marks } of parseInlineMarkdownPieces(text)) {
    result.fill(marks, start, end);
  }
  return result;
}
