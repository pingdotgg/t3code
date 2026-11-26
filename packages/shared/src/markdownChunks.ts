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
const ORDERED_ITEM = /^\d{1,9}[.)](?:[ \t]|\r?$)/;
// CommonMark HTML blocks of types 1-5 and display math run past blank lines until their closer.
const SPANNING_BLOCKS: ReadonlyArray<readonly [open: RegExp, close: RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  // "<!-->" and "<!--->" close themselves, so the closer is searched from just after "<!".
  [/^ {0,3}<!(?=--)/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}\$\$/, /\$\$/],
];

// CommonMark type-6 block tags start an HTML block even with trailing text or across lines.
const HTML_BLOCK_TAG =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t>]|\/>|\r?$)/i;
// CommonMark type-7 HTML blocks require a complete standalone open or closing tag on the line.
const HTML_STANDALONE_TAG =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\r"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\r?$/;
const BLANK_LINE = /^[ \t]*\r?$/;
const closesAtBlankLine = (next: string) => BLANK_LINE.test(next);

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

/** Returns how to recognize the end of a block that `line` opens, or null for none. */
function blockCloser(line: string): ((line: string) => boolean) | null {
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
  // Other HTML blocks (CommonMark types 6 and 7) run until a blank line.
  return HTML_BLOCK_TAG.test(line) || HTML_STANDALONE_TAG.test(line) ? closesAtBlankLine : null;
}

export interface MarkdownChunk {
  readonly text: string;
  readonly lines: number;
}

const FRONTMATTER_OPEN = /^\uFEFF?---[ \t]*\r?$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
// Cap the lookahead for a frontmatter closer; a leading rule with none is a thematic break.
const FRONTMATTER_MAX_LINES = 1000;

const hasFrontmatterClose = (lines: readonly string[]) =>
  lines.slice(1, FRONTMATTER_MAX_LINES + 1).some((line) => FRONTMATTER_CLOSE.test(line));

// A one-line link reference definition; footnotes are collected separately so body pieces do not
// each render their own footnote section.
const LINK_DEFINITION =
  /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(?:<[^<>\n]*>|([^\s<]\S*))(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\r?$/;
const FOOTNOTE_DEFINITION_START = /^ {0,3}\[\^([^\s[\]]+)\]:/;
const FOOTNOTE_CONTINUATION_INDENT = /^(?: {4}|\t)/;
const FOOTNOTE_BLOCK_INTERRUPT = /^ {0,3}(?:>|[-*+](?:[ \t]|\r?$)|\d{1,9}[.)](?:[ \t]|\r?$))/;
// Definitions past this are not repeated into every piece; their parse cost would outweigh links.
const SHARED_DEFINITIONS_MAX_CHARS = 16 * 1024;
const SHARED_FOOTNOTES_MAX_CHARS = 64 * 1024;

function isLinkDefinition(line: string): boolean {
  const match = LINK_DEFINITION.exec(line);
  if (!match) return false;
  const bareDestination = match[1];
  if (bareDestination === undefined) return true;
  let depth = 0;
  for (let i = 0; i < bareDestination.length; i++) {
    const ch = bareDestination[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth < 0) {
      return false;
    }
  }
  return depth === 0;
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
    if (ch === "]" && text[i + 1] === "(") {
      const end = linkDestinationEnd(text, i + 2);
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
  const capturedFootnoteKeys = new Set<string>();
  const seenFootnoteKeys = new Set<string>();
  const capturedFootnoteLabels: string[] = [];
  const footnoteDefs: string[] = [];
  const footnoteDefSpans: (readonly [offset: number, length: number])[] = [];
  let lineOffset = 0;
  let activeFootnoteOffset = 0;
  let lines: string[] = [];
  let chunkStartLine = 0;
  let first = true;
  let chars = 0;
  let closes: ((line: string) => boolean) | null = null;
  let afterBlankLine = false;
  let afterDefinition = false;
  let afterHeading = false;
  let openedFence = false;
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

  const flush = (endLine: number) => {
    chunks.push({ text: lines.join("\n"), lines: lines.length });
    if (mayHaveFootnotes) chunkLineRanges.push([chunkStartLine, endLine]);
    chunkStartLine = endLine;
    lines = [];
    chars = 0;
    heldCut = 0;
  };

  const sourceLines = text.split("\n");
  const isBodyLine = mayHaveFootnotes ? new Uint8Array(sourceLines.length) : null;

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
    const line = sourceLines[lineIndex]!;
    let handledAsFootnote = false;

    if (closes !== null) {
      if (closes(line)) closes = null;
    } else if (first && FRONTMATTER_OPEN.test(line) && hasFrontmatterClose(sourceLines)) {
      closes = (next) => {
        openedFence = FRONTMATTER_CLOSE.test(next);
        return openedFence;
      };
    } else {
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
          afterDefinition = true;
        }
      }

      if (!handledAsFootnote) {
        if (chars >= WRAPPED_MAX_CHARS) openWrappers = 0;
        const cutPoint =
          chars >= targetChars &&
          ((line.startsWith("#") && ATX_HEADING.test(line)) ||
            (afterBlankLine && BLOCK_START.test(line) && !ORDERED_ITEM.test(line)));
        if (cutPoint && openWrappers === 0) flush(lineIndex);
        else if (cutPoint) heldCut = lines.length;

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
            activeFootnoteOffset = lineOffset;
          } else {
            activeFootnoteLabel = null;
            activeFootnoteLines = null;
          }
          pendingFootnoteBlanks = [];
          afterDefinition = false;
          openedFence = false;
          handledAsFootnote = true;
        } else {
          closes = blockCloser(line);
          // Two or more spaces may put a fence in a list item, which this does not track.
          openedFence = /^ ?[`~]/.test(line) && FENCE_OPEN.test(line);
          // A definition cannot interrupt a paragraph, so it follows a blank line, a heading,
          // a closing code fence or frontmatter, or another definition.
          const definition: boolean =
            (first || afterBlankLine || afterDefinition || afterHeading) && isLinkDefinition(line);
          afterDefinition = definition;
          if (definition && definitionChars + line.length < SHARED_DEFINITIONS_MAX_CHARS) {
            definitions.push(line.trim());
            definitionChars += line.length + 1;
          }
          if (
            isBodyLine !== null &&
            closes === null &&
            !definition &&
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
    lines.push(line);
    chars += line.length + 1;
    lineOffset += line.length + 1;
    // A piece too large to render goes back to the last cut a wrapper held.
    if (heldCut > 0 && chars - 1 > LARGE_MARKDOWN_CHUNK_MAX_CHARS) {
      const cutLine = chunkStartLine + heldCut;
      const rest = lines.splice(heldCut);
      flush(cutLine);
      lines = rest;
      chars = rest.reduce((sum, kept) => sum + kept.length + 1, 0);
      openWrappers = 0;
    }
    afterBlankLine = BLANK_LINE.test(line);
    afterHeading =
      !handledAsFootnote &&
      closes === null &&
      (openedFence || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line));
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
    const chunkRefs: string[][] = chunkLineRanges.map(([start, end]) => {
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
