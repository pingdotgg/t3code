/**
 * Inline markdown styling for the rich text composer.
 *
 * The composer's stored prompt stays plain markdown (`**bold**`), while the
 * Tiptap surface renders styled text. These helpers translate between the two:
 * parsing markdown into marked spans for the document, serializing marked
 * spans back to markdown, and mapping cursor offsets between document
 * coordinates (markers excluded) and markdown coordinates (markers included).
 *
 * Deliberately small: bold, italic, strikethrough, and inline code only.
 * Unmatched markers stay literal text so nothing the user typed is ever lost.
 */

export type RichTextMark = "bold" | "italic" | "strike" | "code";

export interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export interface RichMarkRange {
  /** Document-text coordinates (markers excluded), end-exclusive. */
  start: number;
  end: number;
  marks: RichTextMark[];
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** Nesting order, outermost first, used when several marks share a span. */
const MARK_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

function sortMarks(marks: RichTextMark[]): RichTextMark[] {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b));
}

function pushSpan(spans: RichTextSpan[], text: string, marks: RichTextMark[]): void {
  if (!text) return;
  const sorted = sortMarks(marks);
  const last = spans[spans.length - 1];
  if (
    last &&
    last.marks.length === sorted.length &&
    last.marks.every((mark, index) => mark === sorted[index])
  ) {
    last.text += text;
    return;
  }
  spans.push({ text, marks: sorted });
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpMatchArray | null {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match && match.index === index ? match : null;
}

// Code spans are parsed first so `**` inside backticks stays literal.
const CODE_PATTERN = /`([^`\n]+?)`/gy;
const BOLD_PATTERN = /(\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*|__(?=[^\s_])(.+?)(?<=[^\s_])__)/gy;
const STRIKE_PATTERN = /~~(?=[^\s~])(.+?)(?<=[^\s~])~~/gy;
// Single `*` emphasis. Bold is consumed before this runs, so a leftover `*`
// pair is italic. Underscore emphasis requires non-word boundaries on both
// sides so snake_case identifiers keep their underscores.
const ITALIC_STAR_PATTERN = /\*(?=[^\s*])(.+?)(?<=[^\s*])\*/gy;
const ITALIC_UNDERSCORE_PATTERN = /(?<=^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?=$|[^\w])/gy;

function parseNonCodeSpans(text: string, spans: RichTextSpan[], outer: RichTextMark[]): void {
  let index = 0;
  let literalStart = 0;
  const flushLiteral = (end: number) => {
    if (end > literalStart) pushSpan(spans, text.slice(literalStart, end), outer);
    literalStart = end;
  };

  while (index < text.length) {
    const bold = matchAt(BOLD_PATTERN, text, index);
    if (bold) {
      flushLiteral(index);
      const inner = bold[2] ?? bold[3] ?? "";
      // Recurse so `**a *b* c**` keeps the italic on `b`.
      parseNonCodeSpans(inner, spans, [...outer, "bold"]);
      index += bold[0].length;
      literalStart = index;
      continue;
    }
    const strike = matchAt(STRIKE_PATTERN, text, index);
    if (strike) {
      flushLiteral(index);
      parseNonCodeSpans(strike[1] ?? "", spans, [...outer, "strike"]);
      index += strike[0].length;
      literalStart = index;
      continue;
    }
    const italicStar = matchAt(ITALIC_STAR_PATTERN, text, index);
    if (italicStar) {
      flushLiteral(index);
      pushSpan(spans, italicStar[1] ?? "", [...outer, "italic"]);
      index += italicStar[0].length;
      literalStart = index;
      continue;
    }
    const italicUnderscore = matchAt(ITALIC_UNDERSCORE_PATTERN, text, index);
    if (italicUnderscore) {
      flushLiteral(index);
      pushSpan(spans, italicUnderscore[1] ?? "", [...outer, "italic"]);
      index += italicUnderscore[0].length;
      literalStart = index;
      continue;
    }
    index += 1;
  }
  flushLiteral(text.length);
}

/**
 * Parse one plain-text chunk (no inline composer tokens) into styled spans.
 * The concatenated span text always equals the input.
 */
export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  if (!text) return spans;
  let index = 0;
  let literalStart = 0;
  while (index < text.length) {
    const code = matchAt(CODE_PATTERN, text, index);
    if (code) {
      if (index > literalStart) parseNonCodeSpans(text.slice(literalStart, index), spans, []);
      pushSpan(spans, code[1] ?? "", ["code"]);
      index += code[0].length;
      literalStart = index;
      continue;
    }
    index += 1;
  }
  if (text.length > literalStart) parseNonCodeSpans(text.slice(literalStart), spans, []);
  return spans;
}

/** Serialize styled spans back to markdown. Inverse of {@link parseInlineMarkdown}. */
export function serializeInlineMarkdown(spans: ReadonlyArray<RichTextSpan>): string {
  let out = "";
  for (const span of spans) {
    if (span.marks.includes("code")) {
      out += `\`${span.text}\``;
      continue;
    }
    let open = "";
    let close = "";
    for (const mark of sortMarks(span.marks)) {
      // Innermost mark wraps first so closers mirror openers.
      const delimiter = RICH_TEXT_DELIMITERS[mark];
      open = open + delimiter;
      close = delimiter + close;
    }
    out += `${open}${span.text}${close}`;
  }
  return out;
}

function delimiterLength(marks: ReadonlyArray<RichTextMark>): number {
  return marks.reduce((total, mark) => total + RICH_TEXT_DELIMITERS[mark].length, 0);
}

/**
 * Collect styled ranges in document-text coordinates from styled spans.
 * Ranges are one entry per mark so overlapping marks map independently.
 */
export function richMarkRanges(spans: ReadonlyArray<RichTextSpan>): RichMarkRange[] {
  const ranges: RichMarkRange[] = [];
  let offset = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    for (const mark of span.marks) {
      ranges.push({ start: offset, end, marks: [mark] });
    }
    offset = end;
  }
  return ranges;
}

/**
 * Map a document offset (markers excluded) to a markdown offset (markers
 * included). Offsets at or inside a styled range gain that range's opening
 * markers; offsets past it gain both sides. A caret at the very end of a
 * styled range therefore sits before its closing markers, beside the text.
 */
export function docOffsetToMarkdownOffset(
  ranges: ReadonlyArray<RichMarkRange>,
  docOffset: number,
): number {
  let markdownOffset = docOffset;
  for (const range of ranges) {
    const delimiter = delimiterLength(range.marks);
    if (docOffset > range.end) {
      markdownOffset += delimiter * 2;
    } else if (docOffset >= range.start) {
      markdownOffset += delimiter;
    }
  }
  return markdownOffset;
}

/**
 * Map a markdown offset back to a document offset. Offsets landing on marker
 * characters clamp to the adjacent styled edge: markers are shown, never
 * edited, so the caret can never rest inside them.
 */
export function markdownOffsetToDocOffset(
  ranges: ReadonlyArray<RichMarkRange>,
  markdownOffset: number,
  docLength: number,
): number {
  // Marker interiors snap to the styled edge before the general search runs:
  // the forward map jumps over marker spans, so inverting it directly would
  // strand closing-marker offsets on the wrong side of trailing text.
  for (const range of ranges) {
    const delimiter = delimiterLength(range.marks);
    const innerStart = docOffsetToMarkdownOffset(ranges, range.start);
    const innerEnd = docOffsetToMarkdownOffset(ranges, range.end);
    if (markdownOffset > innerStart - delimiter && markdownOffset <= innerStart) {
      return range.start;
    }
    if (markdownOffset > innerEnd && markdownOffset <= innerEnd + delimiter) {
      return range.end;
    }
  }
  for (let docOffset = 0; docOffset <= docLength; docOffset += 1) {
    if (docOffsetToMarkdownOffset(ranges, docOffset) >= markdownOffset) return docOffset;
  }
  return docLength;
}
