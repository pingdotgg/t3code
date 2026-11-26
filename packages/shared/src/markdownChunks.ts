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
const BLOCK_QUOTE = /^ {0,3}>/;
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

/** Returns how to recognize the end of a block that `line` opens, or null for none. */
function blockCloser(line: string): ((line: string) => boolean) | null {
  for (const [open, close] of SPANNING_BLOCKS) {
    const opener = open.exec(line)?.[0];
    if (opener === undefined) continue;
    return close.test(line.slice(opener.length)) ? null : (next) => close.test(next);
  }
  // Other HTML blocks (CommonMark types 6 and 7) run until a blank line.
  return HTML_BLOCK_TAG.test(line) || HTML_STANDALONE_TAG.test(line) ? closesAtBlankLine : null;
}

/** Whether `line`, ignoring its indentation, opens a block instead of continuing a paragraph. */
function startsBlock(line: string): boolean {
  const content = line.trimStart();
  return (
    FENCE_OPEN.test(content) ||
    LIST_ITEM.test(content) ||
    BLOCK_QUOTE.test(content) ||
    ATX_HEADING.test(content) ||
    THEMATIC_BREAK.test(content) ||
    HTML_BLOCK_TAG.test(content) ||
    SPANNING_BLOCKS.some(([open]) => open.test(content))
  );
}

function fenceCloser(fence: string, contentColumn: number): (line: string) => boolean {
  return (line) => {
    const match = /^([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
    if (!match || match[2]![0] !== fence[0] || match[2]!.length < fence.length) return false;
    const indent = indentationColumn(match[1]!);
    return indent >= contentColumn && indent <= contentColumn + 3;
  };
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

// A one-line link reference definition; footnotes are left alone so each piece does not grow
// a footnote section.
const LINK_DEFINITION =
  /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(?:<[^<>\n]*>|([^\s<]\S*))(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\r?$/;
// Definitions past this are not repeated into every piece; their parse cost would outweigh links.
const SHARED_DEFINITIONS_MAX_CHARS = 16 * 1024;

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
  let lines: string[] = [];
  let first = true;
  let chars = 0;
  let closes: ((line: string) => boolean) | null = null;
  let afterBlankLine = false;
  let afterDefinition = false;
  let afterHeading = false;
  let openedFence = false;
  let fenceContentIndent = 0;
  let listContentIndent = Infinity;
  const parentListIndents: number[] = [];
  let listMarker = "";
  let emptyListItem = false;
  let paragraphOpen = false;
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
  for (const line of sourceLines) {
    const blank = BLANK_LINE.test(line);
    const whitespace = /^[ \t]*/.exec(line)![0];
    const indent = indentationColumn(whitespace);
    if (emptyListItem && (blank || indent < listContentIndent)) listContentIndent = Infinity;
    emptyListItem = false;
    if (closes === null && !blank && (afterBlankLine || !paragraphOpen || startsBlock(line))) {
      // Leaving a nested item returns to its parent's content column.
      while (parentListIndents.length > 0 && indent < listContentIndent) {
        listContentIndent = parentListIndents.pop()!;
      }
    }
    const dedented = indent < listContentIndent;
    if (closes !== null && openedFence && indent < fenceContentIndent && !blank) {
      // A dedent ends the list fence before this line, which may open a new fence.
      closes = null;
      afterHeading = true;
    }
    if (closes !== null) {
      if (closes(line)) closes = null;
    } else if (first && FRONTMATTER_OPEN.test(line) && hasFrontmatterClose(sourceLines)) {
      closes = (next) => {
        openedFence = FRONTMATTER_CLOSE.test(next);
        return openedFence;
      };
    } else {
      if (chars >= WRAPPED_MAX_CHARS) openWrappers = 0;
      const cutPoint =
        chars >= targetChars &&
        ((line.startsWith("#") && ATX_HEADING.test(line)) ||
          (afterBlankLine && BLOCK_START.test(line) && !LIST_ITEM.test(line)));
      if (cutPoint && openWrappers === 0) flush();
      else if (cutPoint) heldCut = lines.length;
      const afterFence = afterHeading && openedFence && dedented;
      const heading = ATX_HEADING.test(line);
      const thematicBreak = THEMATIC_BREAK.test(line);
      const quote = BLOCK_QUOTE.test(line);
      const htmlOrMath =
        HTML_BLOCK_TAG.test(line) || SPANNING_BLOCKS.some(([open]) => open.test(line));
      let contentColumn = dedented ? 0 : listContentIndent;
      const canStartBlock = indent - contentColumn <= 3;
      const content = canStartBlock ? line.slice(whitespace.length) : "";
      const item = thematicBreak ? null : LIST_ITEM.exec(content);
      const marker = item?.[1];
      const itemContent = item ? content.slice(item[0].length) : "";
      const itemIsEmpty = BLANK_LINE.test(itemContent);
      const markerKind = marker?.at(-1);
      const continuesList = dedented && listContentIndent !== Infinity && markerKind === listMarker;
      const opensItem: boolean =
        item !== null &&
        (!paragraphOpen ||
          continuesList ||
          (!itemIsEmpty && (!/^\d/.test(marker!) || /^1[.)]$/.test(marker!))));
      let fenceLine = content;
      let startsIndentedCode = false;
      if (item && opensItem) {
        const markerEnd = indent + item[1]!.length;
        const paddedColumn = indentationColumn(item[2]!, markerEnd);
        emptyListItem = dedented && itemIsEmpty;
        // Empty items and items starting with indented code use one column of padding.
        startsIndentedCode = paddedColumn - markerEnd > 4;
        contentColumn = itemIsEmpty || startsIndentedCode ? markerEnd + 1 : paddedColumn;
        fenceLine = startsIndentedCode ? "" : itemContent;
      }
      const fence = FENCE_OPEN.exec(fenceLine)?.[1];
      closes = fence ? fenceCloser(fence, contentColumn) : blockCloser(line);
      fenceContentIndent = fence ? contentColumn : 0;
      if (!dedented && opensItem) {
        parentListIndents.push(listContentIndent);
        listContentIndent = contentColumn;
      } else if (dedented) {
        if (opensItem) {
          parentListIndents.length = 0;
          listContentIndent = contentColumn;
          listMarker = markerKind!;
        } else if (
          !blank &&
          (afterBlankLine || afterFence || heading || thematicBreak || quote || fence || htmlOrMath)
        ) {
          // Dedented prose can still be a lazy continuation until a block boundary.
          parentListIndents.length = 0;
          listContentIndent = Infinity;
        }
      }
      // A definition cannot interrupt a paragraph, so it follows a blank line, a heading,
      // a closing code fence or frontmatter, or another definition.
      const definition: boolean =
        (first || afterBlankLine || afterDefinition || afterHeading) && isLinkDefinition(line);
      openedFence = fence !== undefined;
      afterDefinition = definition;
      paragraphOpen =
        !blank &&
        !definition &&
        !heading &&
        !thematicBreak &&
        !quote &&
        !htmlOrMath &&
        closes === null &&
        (canStartBlock || paragraphOpen) &&
        (!opensItem || (!itemIsEmpty && !startsIndentedCode));
      if (definition && definitionChars + line.length < SHARED_DEFINITIONS_MAX_CHARS) {
        definitions.push(line.trim());
        definitionChars += line.length + 1;
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
    afterBlankLine = blank;
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
