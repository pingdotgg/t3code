import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { maskMarkdownFrontmatter } from "./markdownFrontmatter.ts";

// About one screen of rendered Markdown; parsing costs up to ~40 ms per KB with tables and math.
const CHUNK_TARGET_CHARS = 4 * 1024;
// A chunk past this (one huge fence or HTML block) is too slow to parse at once; show source.
export const LARGE_MARKDOWN_CHUNK_MAX_CHARS = 128 * 1024;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|\r?$)/;
// A thematic break, or a "---" setext underline; no paragraph stays open after either. A lone
// "===" is paragraph text unless it underlines one, so it is left out.
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/;
// A column-0 paragraph, quote or table after a blank line closes any open list, quote or table.
const BLOCK_START = /^[\p{L}\p{N}`[!|>]/u;
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))([ \t]+|(?=\r?$))/;
// Further markers on an item's first line open nested items that start on the same line.
const NESTED_LIST_MARKERS = /^(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|(?=\r?$)))+/;
const BLOCK_QUOTE = /^ {0,3}>/;
const DISPLAY_MATH_OPEN = /^ {0,3}\$\$/;
// CommonMark HTML blocks of types 1-5 and display math run past blank lines until their closer.
const SPANNING_BLOCKS: ReadonlyArray<readonly [open: RegExp, close: RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  // "<!-->" and "<!--->" close themselves, so the closer is searched from just after "<!".
  [/^ {0,3}<!(?=--)/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [DISPLAY_MATH_OPEN, /\$\$/],
];

// CommonMark type-6 block tags start an HTML block even with trailing text or across lines.
const HTML_BLOCK_TAG =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t>]|\/>|\r?$)/i;
// CommonMark type-7 HTML blocks require a complete standalone open or closing tag on the line.
const HTML_STANDALONE_TAG =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\r"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\r?$/;
const BLANK_LINE = /^[ \t]*\r?$/;
const closesAtBlankLine = (next: string) => BLANK_LINE.test(next);
const flowParser = unified().use(remarkParse).use(remarkGfm).freeze();
const HTML_FLOW_MAX_CHARS = 8 * 1024;
// Parsing is far slower than the line scan, so a whole document shares one budget.
const HTML_PARSE_BUDGET_CHARS = 16 * 1024;

function indentationColumn(whitespace: string, column = 0): number {
  for (const character of whitespace) {
    column += character === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

// A <details> or <table> wraps the Markdown between its tags, across the blank lines that end
// each HTML block, so a cut waits until the ones an HTML block opened are closed.
const WRAPPER_TAG = /<(\/?)(?:details|table)(?=[\s/>]|$)/gi;
// An end tag that never comes, or back-to-back wrappers, must not make one huge piece.
const WRAPPED_MAX_CHARS = 32 * 1024;

function withoutComments(line: string): string {
  let kept = "";
  let at = 0;
  for (let open = line.indexOf("<!--"); open !== -1; open = line.indexOf("<!--", at)) {
    const close = line.indexOf("-->", open + 4);
    if (close === -1) break;
    kept += line.slice(at, open);
    at = close + 3;
  }
  return kept + line.slice(at);
}

function openedWrappers(line: string): number {
  let opened = 0;
  for (const [, closing] of withoutComments(line).matchAll(WRAPPER_TAG)) {
    opened += closing ? -1 : 1;
  }
  return opened;
}

/** Whether `text` opens a block that ends a paragraph and is not one itself. */
function opensNonParagraph(text: string): boolean {
  return (
    ATX_HEADING.test(text) ||
    THEMATIC_BREAK.test(text) ||
    BLOCK_QUOTE.test(text) ||
    FENCE_OPEN.test(text) ||
    HTML_BLOCK_TAG.test(text) ||
    SPANNING_BLOCKS.some(([open]) => open.test(text))
  );
}

/** Null means the block ends on this line. Undefined means no block opens. */
function blockCloser(line: string): ((line: string) => boolean) | null | undefined {
  const fence = FENCE_OPEN.exec(line)?.[1];
  if (fence) {
    return (next) => {
      const match = FENCE_OPEN.exec(next);
      const closer = match?.[1];
      return (
        match !== null &&
        closer !== undefined &&
        closer[0] === fence[0] &&
        closer.length >= fence.length &&
        BLANK_LINE.test(next.slice(match[0].length))
      );
    };
  }
  for (const [open, close] of SPANNING_BLOCKS) {
    const opener = open.exec(line)?.[0];
    if (opener === undefined) continue;
    return close.test(line.slice(opener.length)) ? null : (next) => close.test(next);
  }
  return HTML_BLOCK_TAG.test(line) ? closesAtBlankLine : undefined;
}

export interface MarkdownChunk {
  readonly text: string;
  readonly lines: number;
  readonly separator?: "\n" | "\r";
}

const FRONTMATTER_OPEN = /^\uFEFF?---[ \t]*\r?$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
// Cap the lookahead for a frontmatter closer; a leading rule with none is a thematic break.
const FRONTMATTER_MAX_LINES = 1000;

// A bare CR ends a line too; CRLF lines keep their `\r`, which the patterns here allow.
function nextLineBreak(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) return i;
  }
  return text.length;
}

const hasFrontmatterClose = (lines: readonly string[]) =>
  lines.slice(1, FRONTMATTER_MAX_LINES + 1).some((line) => FRONTMATTER_CLOSE.test(line));

// Footnotes are collected separately so body pieces do not each render their own footnote section.
const LINK_DEFINITION_START = /^ {0,3}\[(?!\^)/;
const LINK_LABEL_MAX_CHARS = 999;
const LINK_TITLE_START = /^[ \t]*(["'(])/;
// Definitions past this are not repeated into every piece; their parse cost would outweigh links.
const SHARED_DEFINITIONS_MAX_CHARS = 16 * 1024;
const SHARED_FOOTNOTES_MAX_CHARS = 64 * 1024;
const FOOTNOTE_DEFINITION_START = /^ {0,3}\[\^([^\s[\]]+)\]:/;
const FOOTNOTE_CONTINUATION_INDENT = /^(?: {4}|\t)/;
const LIST_ITEM_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)/;
const FOOTNOTE_BLOCK_INTERRUPT = /^ {0,3}(?:>|[-*+](?:[ \t]|\r?$)|\d{1,9}[.)](?:[ \t]|\r?$))/;
const definitionParser = unified().use(remarkParse);

function hasDefinitionLabel(lines: readonly string[], start: number): boolean {
  const opener = LINK_DEFINITION_START.exec(lines[start]!);
  if (!opener) return false;

  let column = opener[0].length;
  let labelChars = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (BLANK_LINE.test(line)) return false;
    const end = line.endsWith("\r") ? line.length - 1 : line.length;
    for (; column < end && labelChars <= LINK_LABEL_MAX_CHARS; column++, labelChars++) {
      const char = line[column];
      if (char === "]") return line[column + 1] === ":";
      if (char === "[") return false;
      if (char === "\\" && /[\\[\]]/.test(line[column + 1] ?? "")) {
        column++;
        labelChars++;
      }
    }
    if (labelChars > LINK_LABEL_MAX_CHARS) return false;
    column = 0;
  }
  return false;
}

function endsDefinitionRun(line: string) {
  // The preview treats display math as a block even when plain Remark would consume its opener.
  return (
    BLANK_LINE.test(line) ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    FENCE_OPEN.test(line) ||
    DISPLAY_MATH_OPEN.test(line)
  );
}

function findTitleEnd(lines: readonly string[], start: number, opener: RegExpExecArray) {
  const closer = opener[1] === "(" ? ")" : opener[1];
  let column = opener[0].length;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (endsDefinitionRun(line)) return;
    for (; column < line.length; column++) {
      const char = line[column];
      if (char === closer) return BLANK_LINE.test(line.slice(column + 1)) ? index : undefined;
      if (char === "\\" && (line[column + 1] === closer || line[column + 1] === "\\")) column++;
    }
    column = 0;
  }
}

function readLinkDefinitions(lines: readonly string[], start: number) {
  const definitions = new Map<number, { text?: string; end: number; identifier: string }>();
  let chars = lines[start]!.length;
  if (chars >= SHARED_DEFINITIONS_MAX_CHARS) return definitions;
  let end = start + 1;
  let capped = false;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (endsDefinitionRun(line)) break;
    chars += line.length + 1;
    if (chars >= SHARED_DEFINITIONS_MAX_CHARS) {
      capped = true;
      break;
    }
  }

  const text = lines.slice(start, end).join("\n");
  let partialTitleStart: number | undefined;
  for (const node of definitionParser.parse(text).children) {
    if (node.type !== "definition" || !node.position) break;
    const { start: from, end: to } = node.position;
    const firstLine = start + from.line - 1;
    if (!LINK_DEFINITION_START.test(lines[firstLine]!)) break;
    const lastLine = start + to.line - 1;
    definitions.set(firstLine, {
      text: text.slice(from.offset, to.offset),
      end: lastLine,
      identifier: node.identifier,
    });
    partialTitleStart =
      capped && node.title == null && LINK_TITLE_START.test(lines[lastLine + 1] ?? "")
        ? firstLine
        : undefined;
  }
  if (partialTitleStart !== undefined) {
    // Retry at the candidate's label before looking beyond the batch limit.
    if (partialTitleStart !== start) {
      definitions.delete(partialTitleStart);
    } else {
      const titleStart = definitions.get(start)!.end + 1;
      const opener = LINK_TITLE_START.exec(lines[titleStart]!)!;
      const titleEnd = findTitleEnd(lines, titleStart, opener);
      if (titleEnd !== undefined && titleEnd >= end) {
        const full = definitionParser.parse(lines.slice(start, titleEnd + 1).join("\n"))
          .children[0];
        if (full?.type === "definition" && full.title != null) {
          definitions.set(start, { end: titleEnd, identifier: full.identifier });
        }
      }
    }
  }
  return definitions;
}

function isSpanningBlockOpen(line: string): boolean {
  const firstChar = line.trimStart()[0];
  if (firstChar !== "<" && firstChar !== "$") return false;
  return SPANNING_BLOCKS.some(([open]) => open.test(line));
}

function interruptsFootnoteDefinition(line: string): boolean {
  return (
    (line.includes("[^") && FOOTNOTE_DEFINITION_START.test(line)) ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    FENCE_OPEN.test(line) ||
    FOOTNOTE_BLOCK_INTERRUPT.test(line) ||
    HTML_BLOCK_TAG.test(line) ||
    HTML_STANDALONE_TAG.test(line) ||
    isSpanningBlockOpen(line)
  );
}

const FOOTNOTE_INDENT_AFTER_QUOTE = /^[ \t]? {0,3}$/;

/** End of a link destination's `)` from `start`, or -1 for titles and nested parentheses. */
function linkDestinationEnd(text: string, start: number): number {
  // Every scan stops at the next `(` or `<`, so the scans of one paragraph do not overlap.
  let j = start;
  if (text[j] === "<") {
    for (j++; j < text.length && text[j] !== ">"; j++) {
      if (text[j] === "<" || text[j] === "\n") return -1;
      if (text[j] === "\\") j++;
    }
    return text[j + 1] === ")" ? j + 1 : -1;
  }
  for (; j < text.length; j++) {
    const c = text[j]!;
    if (c === ")") return j;
    if (c === "(" || c === "<" || /\s/.test(c)) return -1;
    if (c === "\\") j++;
  }
  return -1;
}

/** Finds matching footnote references in body prose, skipping escapes, code spans, inline math, HTML comments, and link destinations. */
function extractFootnoteRefs(text: string, definedKeys: ReadonlySet<string>): string[] {
  if (!text.includes("[^")) return [];
  const refs: string[] = [];
  // Scans that found no close mark where later ones would fail too, so no text is rescanned.
  let mathUnclosedUntil = -1;
  let commentUnclosed = false;
  // Unmatched `[`; a `](` without one is literal text, not the start of a destination.
  let openBrackets = 0;
  // The current line's leading `>` markers and indentation, tracked forward.
  let scanned = 0;
  let prefixEnd = 0;
  let quoteEnd = 0;
  const isAtLineStart = (i: number) => {
    for (; scanned < i; scanned++) {
      const c = text[scanned];
      if (c === "\n") prefixEnd = quoteEnd = scanned + 1;
      else if (prefixEnd === scanned && (c === " " || c === "\t" || c === ">")) {
        prefixEnd++;
        if (c === ">") quoteEnd = prefixEnd;
      }
    }
    return prefixEnd === i && FOOTNOTE_INDENT_AFTER_QUOTE.test(text.slice(quoteEnd, i));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks++;
      let j = i + ticks;
      let closed = -1;
      while (j < text.length) {
        if (text[j] === "`") {
          let run = 1;
          while (text[j + run] === "`") run++;
          if (run === ticks) {
            closed = j + run - 1;
            break;
          }
          j += run;
          continue;
        }
        j++;
      }
      if (closed !== -1) i = closed;
      else i += ticks - 1;
      continue;
    }
    if (ch === "$" && text[i + 1] !== "$" && i >= mathUnclosedUntil) {
      const next = text[i + 1];
      if (next !== undefined && next !== " " && next !== "\t" && next !== "\n") {
        let j = i + 1;
        let closed = -1;
        while (j < text.length && text[j] !== "\n") {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (
            text[j] === "$" &&
            text[j + 1] !== "$" &&
            text[j - 1] !== " " &&
            text[j - 1] !== "\t"
          ) {
            closed = j;
            break;
          }
          j++;
        }
        if (closed !== -1) {
          i = closed;
          continue;
        }
        mathUnclosedUntil = j;
      }
    }
    if (ch === "<" && !commentUnclosed && text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close !== -1) {
        i = close + 2;
        continue;
      }
      commentUnclosed = true;
    }
    if (ch === "[" && text[i + 1] !== "^") openBrackets++;
    if (ch === "]" && openBrackets > 0) {
      openBrackets--;
      const end = text[i + 1] === "(" ? linkDestinationEnd(text, i + 2) : -1;
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (ch === "[" && text[i + 1] === "^") {
      let j = i + 2;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "]" || c === "[" || /\s/.test(c)) break;
        j++;
      }
      if (j > i + 2 && text[j] === "]") {
        const isDefAtLineStart = text[j + 1] === ":" && isAtLineStart(i);
        if (!isDefAtLineStart) {
          const label = text.slice(i + 2, j);
          if (definedKeys.has(label.toLowerCase())) {
            refs.push(label);
          }
        }
        i = j;
      }
    }
  }
  return refs;
}

export interface MarkdownFootnotes {
  /** One-line stub definitions (`[^id]: .`) so body chunks resolve footnote references. */
  readonly stubs: string;
  /** Real footnote definitions in document order for the trailing footnotes section. */
  readonly definitions: string;
  /** Where each of `definitions` sits in the file, so edits made in the section reach the file. */
  readonly definitionSpans: readonly (readonly [offset: number, length: number])[];
  /** Referenced footnote labels in document order for each chunk (empty when a chunk has none). */
  readonly chunkRefs: readonly (readonly string[])[];
}

export interface SplitMarkdown {
  readonly chunks: readonly MarkdownChunk[];
  readonly definitions: string;
  readonly footnotes?: MarkdownFootnotes | undefined;
}

/**
 * Cuts Markdown into pieces of roughly `targetChars`, only at column-0 headings or paragraphs
 * that start a new top-level block. Leading frontmatter stays in the first piece. Link
 * definitions and footnote definitions are collected so references resolve across pieces;
 * duplicate heading slugs still restart per piece.
 */
export function splitMarkdown(text: string, targetChars = CHUNK_TARGET_CHARS): SplitMarkdown {
  const mayHaveFootnotes = text.includes("[^") && text.includes("]:");
  const chunks: MarkdownChunk[] = [];
  const chunkLineRanges: Array<readonly [start: number, end: number]> = [];
  const definitions: string[] = [];
  const omittedDefinitions = new Set<string>();
  const capturedFootnoteKeys = new Set<string>();
  const seenFootnoteKeys = new Set<string>();
  const capturedFootnoteLabels: string[] = [];
  const footnoteDefs: string[] = [];
  const footnoteDefSpans: (readonly [offset: number, length: number])[] = [];
  let activeFootnoteOffset = 0;
  let chunkStartLine = 0;
  let first = true;
  let closes: ((line: string) => boolean) | null = null;
  let ambiguousHtml = false;
  let afterBlankLine = false;
  let definitionEnd = -1;
  let pendingDefinitions: ReturnType<typeof readLinkDefinitions> | undefined;
  let afterHeading = false;
  // Indented code holds literal `[^x]`; an indented line under a list item continues the item.
  let inIndentedCode = false;
  let inList = false;
  let openedStandaloneBlock = false;
  // The outermost list item's content column; a line indented less is outside every item.
  let listContentIndent = Infinity;
  let listMarker = "";
  let emptyListItem = false;
  let paragraphOpen = false;
  let definitionChars = 0;
  let footnoteChars = 0;
  let footnoteCapExceeded = false;
  let openWrappers = 0;
  let heldCut = 0;
  let inFootnoteDef = false;
  let activeFootnoteLabel: string | null = null;
  let activeFootnoteLines: string[] | null = null;
  let pendingFootnoteBlanks: string[] = [];

  const finishFootnoteDef = () => {
    if (activeFootnoteLabel !== null && activeFootnoteLines !== null) {
      const block = activeFootnoteLines.join("\n").trimEnd();
      if (footnoteChars + block.length < SHARED_FOOTNOTES_MAX_CHARS) {
        capturedFootnoteKeys.add(activeFootnoteLabel.toLowerCase());
        capturedFootnoteLabels.push(activeFootnoteLabel);
        footnoteDefs.push(block);
        footnoteDefSpans.push([activeFootnoteOffset, block.length]);
        footnoteChars += block.length + 2;
      } else {
        footnoteCapExceeded = true;
      }
    }
    inFootnoteDef = false;
    activeFootnoteLabel = null;
    activeFootnoteLines = null;
    pendingFootnoteBlanks = [];
  };

  const sourceLines: string[] = [];
  const lineStarts: number[] = [];
  for (let start = 0; start <= text.length;) {
    const end = nextLineBreak(text, start);
    sourceLines.push(text.slice(start, end));
    lineStarts.push(start);
    start = end + 1;
  }
  // Slices the source so each piece keeps its own line endings and the break after it.
  const flush = (endLine: number) => {
    const from = lineStarts[chunkStartLine]!;
    const to = endLine < sourceLines.length ? lineStarts[endLine]! - 1 : text.length;
    const separator = text[to];
    const chunk = { text: text.slice(from, to), lines: endLine - chunkStartLine };
    chunks.push(separator === "\n" || separator === "\r" ? { ...chunk, separator } : chunk);
    if (mayHaveFootnotes) chunkLineRanges.push([chunkStartLine, endLine]);
    chunkStartLine = endLine;
    heldCut = 0;
  };

  const isBodyLine = mayHaveFootnotes ? new Uint8Array(sourceLines.length) : null;

  let flowStart = 0;
  let parsedThrough = 0;
  let htmlStarts: Set<number> | undefined;
  let parseBudget = HTML_PARSE_BUDGET_CHARS;
  const resetFlow = (start: number) => {
    flowStart = start;
    parsedThrough = start;
    htmlStarts = undefined;
  };
  for (const [lineIndex, line] of sourceLines.entries()) {
    const chars = lineStarts[lineIndex]! - lineStarts[chunkStartLine]!;
    const blank = BLANK_LINE.test(line);
    const whitespace = /^[ \t]*/.exec(line)![0];
    const indent = indentationColumn(whitespace);
    if (emptyListItem && (blank || indent < listContentIndent)) listContentIndent = Infinity;
    emptyListItem = false;
    const dedented = indent < listContentIndent;
    let handledAsFootnote = false;
    let interruptedFootnote = false;

    if (closes !== null) {
      if (closes(line)) {
        closes = null;
        resetFlow(lineIndex + 1);
      }
    } else if (first && FRONTMATTER_OPEN.test(line) && hasFrontmatterClose(sourceLines)) {
      closes = (next) => {
        openedStandaloneBlock = FRONTMATTER_CLOSE.test(next);
        return openedStandaloneBlock;
      };
    } else if (lineIndex > definitionEnd) {
      if (inFootnoteDef) {
        if (BLANK_LINE.test(line)) {
          pendingFootnoteBlanks.push(line);
          handledAsFootnote = true;
        } else if (pendingFootnoteBlanks.length > 0) {
          if (FOOTNOTE_CONTINUATION_INDENT.test(line)) {
            if (activeFootnoteLines !== null) {
              activeFootnoteLines.push(...pendingFootnoteBlanks, line);
            }
            pendingFootnoteBlanks = [];
            handledAsFootnote = true;
          } else {
            finishFootnoteDef();
            afterBlankLine = true;
          }
        } else if (FOOTNOTE_CONTINUATION_INDENT.test(line) || !interruptsFootnoteDefinition(line)) {
          if (activeFootnoteLines !== null) activeFootnoteLines.push(line);
          handledAsFootnote = true;
        } else {
          finishFootnoteDef();
          interruptedFootnote = true;
        }
      }

      if (!handledAsFootnote) {
        if (chars >= WRAPPED_MAX_CHARS) openWrappers = 0;
        const cutPoint =
          !ambiguousHtml &&
          chars >= targetChars &&
          ((line.startsWith("#") && ATX_HEADING.test(line)) ||
            (afterBlankLine && BLOCK_START.test(line) && !LIST_ITEM.test(line)));
        if (cutPoint && openWrappers === 0) flush(lineIndex);
        else if (cutPoint) heldCut = lineIndex;

        if (isBodyLine !== null && !BLANK_LINE.test(line)) {
          if (!FOOTNOTE_CONTINUATION_INDENT.test(line)) {
            inIndentedCode = false;
            inList = LIST_ITEM_START.test(line) || (inList && !afterBlankLine);
          } else if (!inList && (first || afterBlankLine || afterHeading)) {
            inIndentedCode = true;
          }
        }

        const fnMatch =
          mayHaveFootnotes && line.includes("[^") ? FOOTNOTE_DEFINITION_START.exec(line) : null;
        if (fnMatch) {
          const label = fnMatch[1]!;
          const key = label.toLowerCase();
          inFootnoteDef = true;
          if (!seenFootnoteKeys.has(key)) {
            seenFootnoteKeys.add(key);
            activeFootnoteLabel = label;
            activeFootnoteLines = [line];
            activeFootnoteOffset = lineStarts[lineIndex]!;
          } else {
            activeFootnoteLabel = null;
            activeFootnoteLines = null;
          }
          pendingFootnoteBlanks = [];
          openedStandaloneBlock = false;
          handledAsFootnote = true;
        } else {
          const closer = blockCloser(line);
          closes = closer ?? null;
          if (closer === null || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line)) {
            resetFlow(lineIndex + 1);
          } else if (closer === undefined && HTML_STANDALONE_TAG.test(line)) {
            // Type-7 HTML cannot interrupt prose. Keep ambiguous tags beyond the parse
            // budget with their following lines, as a cut could expose literal HTML as Markdown.
            if (htmlStarts === undefined && lineIndex > flowStart) {
              let end = flowStart;
              let flowChars = 0;
              const maxChars = Math.min(HTML_FLOW_MAX_CHARS, parseBudget);
              for (; end < sourceLines.length; end++) {
                const next = sourceLines[end]!;
                flowChars += next.length + 1;
                if (flowChars > maxChars || BLANK_LINE.test(next)) break;
                // Include the boundary line, which can end a lazy container continuation.
                if (
                  ATX_HEADING.test(next) ||
                  THEMATIC_BREAK.test(next) ||
                  blockCloser(next) !== undefined
                ) {
                  end++;
                  break;
                }
              }
              parsedThrough = end;
              htmlStarts = new Set();
              if (lineIndex < end) {
                const flowText = sourceLines.slice(flowStart, end).join("\n");
                parseBudget -= flowText.length;
                const flow = flowParser.parse(flowText);
                for (const node of flow.children) {
                  if (node.type === "html" && node.position) {
                    htmlStarts.add(flowStart + node.position.start.line - 1);
                  }
                }
              }
            }
            if (lineIndex === flowStart || htmlStarts?.has(lineIndex)) closes = closesAtBlankLine;
            else if (lineIndex >= parsedThrough) ambiguousHtml = true;
          }
          const afterStandaloneBlock = afterHeading && openedStandaloneBlock && dedented;
          const fence = FENCE_OPEN.test(line);
          // Fence tracking ignores lists, so it finds the real end of a fence indented two or more
          // spaces only when that fence is outside every list item.
          openedStandaloneBlock =
            (fence && (dedented || /^ ?[`~]/.test(line))) ||
            (line.startsWith("<") && SPANNING_BLOCKS.some(([open]) => open.test(line)));
          const thematicBreak = THEMATIC_BREAK.test(line);
          const contentColumn = dedented ? 0 : listContentIndent;
          const canStartBlock = indent - contentColumn <= 3;
          const content = canStartBlock ? line.slice(whitespace.length) : "";
          const item = thematicBreak ? null : LIST_ITEM.exec(content);
          const marker = item?.[1];
          let itemContent = item ? content.slice(item[0].length) : "";
          const itemIsEmpty = BLANK_LINE.test(itemContent);
          const markerKind = marker?.at(-1);
          const continuesList =
            dedented && listContentIndent !== Infinity && markerKind === listMarker;
          const opensItem: boolean =
            item !== null &&
            (!paragraphOpen ||
              continuesList ||
              (!itemIsEmpty && (!/^\d/.test(marker!) || /^1[.)]$/.test(marker!))));
          let startsIndentedCode = false;
          if (item && opensItem) {
            const markerEnd = indent + item[1]!.length;
            const paddedColumn = indentationColumn(item[2]!, markerEnd);
            emptyListItem = dedented && itemIsEmpty;
            // Empty items and items starting with indented code use one column of padding.
            startsIndentedCode = paddedColumn - markerEnd > 4;
            if (dedented) {
              listContentIndent = itemIsEmpty || startsIndentedCode ? markerEnd + 1 : paddedColumn;
              listMarker = markerKind!;
            }
            itemContent = itemContent.replace(NESTED_LIST_MARKERS, "");
          } else if (
            dedented &&
            !blank &&
            (afterBlankLine || afterStandaloneBlock || opensNonParagraph(line))
          ) {
            // Dedented prose can still be a lazy continuation until a block boundary.
            listContentIndent = Infinity;
          }
          let isDefinition = false;
          // A definition cannot interrupt a paragraph, so it follows a blank line, a heading,
          // a closing code fence or frontmatter, or another definition.
          if (
            !ambiguousHtml &&
            (first ||
              afterBlankLine ||
              lineIndex === definitionEnd + 1 ||
              afterHeading ||
              interruptedFootnote)
          ) {
            let definition = pendingDefinitions?.get(lineIndex);
            if (
              !definition &&
              definitionChars < SHARED_DEFINITIONS_MAX_CHARS &&
              hasDefinitionLabel(sourceLines, lineIndex)
            ) {
              pendingDefinitions = readLinkDefinitions(sourceLines, lineIndex);
              definition = pendingDefinitions.get(lineIndex);
            }
            if (definition) {
              isDefinition = true;
              definitionEnd = definition.end;
              if (!omittedDefinitions.has(definition.identifier)) {
                if (
                  definition.text !== undefined &&
                  definitionChars + definition.text.length < SHARED_DEFINITIONS_MAX_CHARS
                ) {
                  definitions.push(definition.text);
                  definitionChars += definition.text.length + 1;
                } else {
                  omittedDefinitions.add(definition.identifier);
                }
              }
            }
          }
          paragraphOpen =
            !blank &&
            !isDefinition &&
            closes === null &&
            (canStartBlock || paragraphOpen) &&
            (item && opensItem
              ? !BLANK_LINE.test(itemContent) &&
                !startsIndentedCode &&
                !opensNonParagraph(itemContent)
              : !opensNonParagraph(line));
          if (
            isBodyLine !== null &&
            closes === null &&
            !inIndentedCode &&
            !isDefinition &&
            !BLANK_LINE.test(line) &&
            !isSpanningBlockOpen(line)
          ) {
            isBodyLine[lineIndex] = 1;
          }
        }
      }
    }

    if (closes === closesAtBlankLine)
      openWrappers = Math.max(0, openWrappers + openedWrappers(line));
    first = false;
    // A piece too large to render goes back to the last cut a wrapper held.
    if (
      heldCut > chunkStartLine &&
      lineStarts[lineIndex]! + line.length - lineStarts[chunkStartLine]! >
        LARGE_MARKDOWN_CHUNK_MAX_CHARS
    ) {
      flush(heldCut);
      openWrappers = 0;
    }
    afterBlankLine = blank;
    if (afterBlankLine) {
      ambiguousHtml = false;
      resetFlow(lineIndex + 1);
    }
    afterHeading =
      !handledAsFootnote &&
      closes === null &&
      (openedStandaloneBlock || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line));
  }
  if (inFootnoteDef) finishFootnoteDef();
  flush(sourceLines.length);

  let footnotes: MarkdownFootnotes | undefined;
  if (
    isBodyLine !== null &&
    !footnoteCapExceeded &&
    chunks.length > 1 &&
    capturedFootnoteKeys.size > 0
  ) {
    let anyRef = false;
    const chunkRefs: string[][] = chunkLineRanges.map(([start, end], index) => {
      // Oversized chunks display as source, so their references have no anchors.
      if (chunks[index]!.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS) return [];
      const refs: string[] = [];
      let block: string[] = [];
      const flushBlock = () => {
        if (block.length === 0) return;
        refs.push(...extractFootnoteRefs(block.join("\n"), capturedFootnoteKeys));
        block = [];
      };
      for (let i = start; i < end; i++) {
        if (isBodyLine[i] === 1) block.push(sourceLines[i]!);
        else flushBlock();
      }
      flushBlock();
      if (refs.length > 0) anyRef = true;
      return refs;
    });
    if (anyRef) {
      footnotes = {
        stubs: capturedFootnoteLabels.map((label) => `[^${label}]: .`).join("\n"),
        definitions: footnoteDefs.join("\n\n"),
        definitionSpans: footnoteDefSpans,
        chunkRefs,
      };
    }
  }

  return footnotes
    ? { chunks, definitions: definitions.join("\n"), footnotes }
    : { chunks, definitions: definitions.join("\n") };
}

export function joinMarkdownChunks(chunks: readonly MarkdownChunk[]): string {
  return chunks
    .map((chunk, index) =>
      index + 1 < chunks.length ? `${chunk.text}${chunk.separator ?? "\n"}` : chunk.text,
    )
    .join("");
}

/** Prepends shared definitions in document order; source offsets shift by the prefix length. */
export function withMarkdownDefinitions(text: string, definitions: string): string {
  if (!definitions) return text;
  const masked = maskMarkdownFrontmatter(text);
  return masked.startsWith("\uFEFF")
    ? `\uFEFF${definitions}\n\n${masked.slice(1)}`
    : `${definitions}\n\n${masked}`;
}

export interface PreparedMarkdownChunk {
  readonly text: string;
  readonly offsetShift: number;
  readonly footnotesMode?: "omit" | "omit-seeded" | undefined;
}

/**
 * Prepares one chunk of a split Markdown document with shared link definitions and, when the
 * chunk references document footnotes, stub definitions plus prior references so footnote numbers
 * and backref IDs match the whole document.
 */
export function prepareMarkdownChunk(
  chunkText: string,
  chunkIndex: number,
  definitions: string,
  footnotes?: MarkdownFootnotes,
): PreparedMarkdownChunk {
  if (!footnotes) {
    return {
      text: withMarkdownDefinitions(chunkText, definitions),
      offsetShift: definitions ? definitions.length + 2 : 0,
    };
  }
  const refsInChunk = footnotes.chunkRefs[chunkIndex];
  if (!refsInChunk || refsInChunk.length === 0) {
    return {
      text: withMarkdownDefinitions(chunkText, definitions),
      offsetShift: definitions ? definitions.length + 2 : 0,
      footnotesMode: "omit",
    };
  }
  const priorRefs: string[] = [];
  for (let i = 0; i < chunkIndex; i++) {
    const refs = footnotes.chunkRefs[i];
    if (refs) priorRefs.push(...refs);
  }
  const prefixParts: string[] = [];
  if (definitions) prefixParts.push(definitions);
  prefixParts.push(footnotes.stubs);
  if (priorRefs.length > 0) {
    prefixParts.push(priorRefs.map((label) => `[^${label}]`).join(" "));
  } else {
    // An HTML comment closes the last stub footnote so a chunk starting with 4-space indented code
    // cannot be absorbed as a continuation of that stub.
    prefixParts.push("<!-- -->");
  }
  const prefix = prefixParts.join("\n\n");
  return {
    text: withMarkdownDefinitions(chunkText, prefix),
    offsetShift: prefix.length + 2,
    footnotesMode: priorRefs.length > 0 ? "omit-seeded" : "omit",
  };
}

export interface MarkdownFootnotesSection {
  readonly text: string;
  /** Maps an offset in `text` to the file, or null outside the footnote definitions. */
  readonly fileOffset: (offset: number) => number | null;
}

/** Builds the Markdown source for the single trailing footnotes section of a split document. */
export function buildMarkdownFootnotesSection(
  definitions: string,
  footnotes?: MarkdownFootnotes,
): MarkdownFootnotesSection | null {
  if (!footnotes || !footnotes.definitions) return null;
  const allRefs = footnotes.chunkRefs.flat();
  if (allRefs.length === 0) return null;
  const parts: string[] = [];
  if (definitions) parts.push(definitions);
  parts.push(allRefs.map((label) => `[^${label}]`).join(" "));
  parts.push(footnotes.definitions);
  const text = parts.join("\n\n");
  const { definitionSpans } = footnotes;
  return {
    text,
    fileOffset: (offset) => {
      let start = text.length - footnotes.definitions.length;
      for (const [fileStart, length] of definitionSpans) {
        if (offset < start) return null;
        if (offset < start + length) return fileStart + offset - start;
        start += length + 2;
      }
      return null;
    },
  };
}

/** Maps a footnote backref (`fnref-<fnNumber>` / `fnref-<fnNumber>-<occurrence>`) to its chunk. */
export function findFootnoteRefChunkIndex(
  footnotes: MarkdownFootnotes,
  fnNumber: number,
  occurrence: number,
): number | null {
  if (fnNumber < 1 || occurrence < 1) return null;
  const numberByKey = new Map<string, number>();
  const countByNumber = new Map<number, number>();
  let nextNumber = 1;
  for (let chunkIndex = 0; chunkIndex < footnotes.chunkRefs.length; chunkIndex++) {
    const refs = footnotes.chunkRefs[chunkIndex];
    if (!refs) continue;
    for (const label of refs) {
      const key = label.toLowerCase();
      let num = numberByKey.get(key);
      if (num === undefined) {
        num = nextNumber++;
        numberByKey.set(key, num);
      }
      const occ = (countByNumber.get(num) ?? 0) + 1;
      countByNumber.set(num, occ);
      if (num === fnNumber && occ === occurrence) {
        return chunkIndex;
      }
    }
  }
  return null;
}
