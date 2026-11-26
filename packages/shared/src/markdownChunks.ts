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
const ORDERED_ITEM = /^\d{1,9}[.)](?:[ \t]|\r?$)/;
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

// Footnotes are left alone so each piece does not grow a footnote section.
const LINK_DEFINITION_START = /^ {0,3}\[(?!\^)/;
const LINK_LABEL_MAX_CHARS = 999;
const LINK_TITLE_START = /^[ \t]*(["'(])/;
// Definitions past this are not repeated into every piece; their parse cost would outweigh links.
const SHARED_DEFINITIONS_MAX_CHARS = 16 * 1024;
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

export interface SplitMarkdown {
  readonly chunks: readonly MarkdownChunk[];
  readonly definitions: string;
}

/**
 * Cuts Markdown into pieces of roughly `targetChars`, only at column-0 headings or paragraphs
 * that start a new top-level block. Leading frontmatter stays in the first piece. Link
 * definitions are collected so every piece can resolve them; footnotes resolve only inside their
 * own piece, and duplicate heading slugs restart per piece.
 */
export function splitMarkdown(text: string, targetChars = CHUNK_TARGET_CHARS): SplitMarkdown {
  const chunks: MarkdownChunk[] = [];
  const definitions: string[] = [];
  const omittedDefinitions = new Set<string>();
  let lines: string[] = [];
  let first = true;
  let chars = 0;
  let closes: ((line: string) => boolean) | null = null;
  let afterBlankLine = false;
  let definitionEnd = -1;
  let pendingDefinitions: ReturnType<typeof readLinkDefinitions> | undefined;
  let afterHeading = false;
  let openedFence = false;
  let definitionChars = 0;
  let openWrappers = 0;
  let heldCut = 0;
  const flush = () => {
    chunks.push({ text: lines.join("\n"), lines: lines.length });
    lines = [];
    chars = 0;
    heldCut = 0;
  };
  const sourceLines = text.split("\n");
  for (const [lineIndex, line] of sourceLines.entries()) {
    if (closes !== null) {
      if (closes(line)) closes = null;
    } else if (first && FRONTMATTER_OPEN.test(line) && hasFrontmatterClose(sourceLines)) {
      closes = (next) => {
        openedFence = FRONTMATTER_CLOSE.test(next);
        return openedFence;
      };
    } else if (lineIndex > definitionEnd) {
      if (chars >= WRAPPED_MAX_CHARS) openWrappers = 0;
      const cutPoint =
        chars >= targetChars &&
        ((line.startsWith("#") && ATX_HEADING.test(line)) ||
          (afterBlankLine && BLOCK_START.test(line) && !ORDERED_ITEM.test(line)));
      if (cutPoint && openWrappers === 0) flush();
      else if (cutPoint) heldCut = lines.length;
      closes = blockCloser(line);
      // Two or more spaces may put a fence in a list item, which this does not track.
      openedFence = /^ ?[`~]/.test(line) && FENCE_OPEN.test(line);
      // A definition cannot interrupt a paragraph, so it follows a blank line, a heading,
      // a closing code fence or frontmatter, or another definition.
      if (first || afterBlankLine || lineIndex === definitionEnd + 1 || afterHeading) {
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
    }
    if (closes === closesAtBlankLine)
      openWrappers = Math.max(0, openWrappers + openedWrappers(line));
    first = false;
    lines.push(line);
    chars += line.length + 1;
    // A piece too large to render goes back to the last cut a wrapper held.
    if (heldCut > 0 && chars - 1 > LARGE_MARKDOWN_CHUNK_MAX_CHARS) {
      const rest = lines.splice(heldCut);
      flush();
      lines = rest;
      chars = rest.reduce((sum, kept) => sum + kept.length + 1, 0);
      openWrappers = 0;
    }
    afterBlankLine = BLANK_LINE.test(line);
    afterHeading =
      closes === null && (openedFence || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line));
  }
  flush();
  return { chunks, definitions: definitions.join("\n") };
}

/** Prepends shared definitions in document order; source offsets shift by the prefix length. */
export function withMarkdownDefinitions(text: string, definitions: string): string {
  if (!definitions) return text;
  const masked = maskMarkdownFrontmatter(text);
  return masked.startsWith("\uFEFF")
    ? `\uFEFF${definitions}\n\n${masked.slice(1)}`
    : `${definitions}\n\n${masked}`;
}
