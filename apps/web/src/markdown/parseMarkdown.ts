// Markdown to mdast, equal to what remark-parse builds with the chat's syntax extensions (GFM,
// math, Codex directives, Windows paths), in a fraction of micromark's time.
import type {
  BlockContent,
  Definition,
  FootnoteDefinition,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";

type Position = NonNullable<Root["position"]>;

import { transformAutolinkLiterals } from "./autolinks";
import {
  BACKSLASH,
  BlockParser,
  CARET,
  COLON,
  CR,
  DASH,
  LBRACKET,
  LF,
  PIPE,
  RBRACKET,
  SPACE,
  TAB,
  isSpaceOrTab,
  isWhitespaceCode,
  newBlock,
  type Block,
  type ContentLine,
} from "./blocks";
import {
  type Content,
  type Definitions,
  InlineParser,
  isWindowsAbsolutePath,
  normalizeIdentifier,
  parseDirectiveAttributes,
  unescapeString,
} from "./inlines";

export interface ParseOptions {
  readonly math?: boolean;
}

interface Point {
  line: number;
  column: number;
  offset: number;
}

interface ParsedDefinition {
  start: number;
  end: number;
  label: string;
  identifier: string;
  url: string;
  title: string | null;
}

type ParagraphBlock = Block & { definitions?: ParsedDefinition[] };
type TableBlock = Block & { align?: Array<"left" | "right" | "center" | null> };
type DirectiveBlock = Block & { name?: string; attributes?: Record<string, string>; labelRange?: [number, number] | undefined };

export function parseMarkdown(document: string, options: ParseOptions = {}): Root {
  const source = document.charCodeAt(0) === 0xfeff ? document.slice(1) : document;
  return new DocumentParser(source, options.math ?? false).parse();
}

class DocumentParser {
  readonly source: string;
  readonly blocks: BlockParser;
  readonly definitions: Definitions = { links: new Map(), footnotes: new Set() };
  readonly math: boolean;

  constructor(source: string, math: boolean) {
    this.source = source;
    this.math = math;
    this.blocks = new BlockParser(source, { math, directives: true });
    this.blocks.onFinalize = (block) => this.onFinalize(block);
    this.blocks.onSetext = (paragraph) => this.onSetext(paragraph);
    this.blocks.onFootnoteDefinition = () => this.startFootnoteDefinition();
    this.blocks.onTable = (container) => this.startTable(container);
    this.blocks.onLeafDirective = () => this.startLeafDirective();
  }

  parse(): Root {
    const root = this.blocks.parse();
    const tree: Root = {
      type: "root",
      children: this.convertChildren(root),
      position: { start: this.point(0), end: this.point(this.source.length) },
    };
    transformAutolinkLiterals(tree);
    return tree;
  }

  point(offset: number): Point {
    const starts = this.blocks.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1, offset };
  }

  position(start: number, end: number) {
    return { start: this.point(start), end: this.point(end) };
  }

  // --- Block hooks --------------------------------------------------------------------------

  onFinalize(block: Block) {
    if (block.type === "paragraph") this.extractDefinitions(block as ParagraphBlock);
  }

  onSetext(paragraph: Block): number | null {
    const block = paragraph as ParagraphBlock;
    this.extractDefinitions(block);
    return block.lines.length === 0 ? null : 0;
  }

  /** Strips link reference definitions from the start of a paragraph. */
  extractDefinitions(block: ParagraphBlock) {
    if (block.definitions) return;
    block.definitions = [];
    while (block.lines.length > 0) {
      const first = block.lines[0]!;
      if (this.source.charCodeAt(first.start) !== LBRACKET) break;
      const parsed = this.parseDefinition(block.lines);
      if (!parsed) break;
      block.definitions.push(parsed.definition);
      if (!this.definitions.links.has(parsed.definition.identifier)) {
        this.definitions.links.set(parsed.definition.identifier, {
          url: parsed.definition.url,
          title: parsed.definition.title,
        });
      }
      block.lines = block.lines.slice(parsed.lines);
      if (block.lines.length > 0) {
        block.lines[0] = { ...block.lines[0]!, start: parsed.restStart ?? block.lines[0]!.start };
      }
    }
  }

  /** A definition at the start of `lines`; how many lines it used. */
  parseDefinition(
    lines: ContentLine[],
  ): { definition: ParsedDefinition; lines: number; restStart?: number } | null {
    const content = this.contentOf(lines);
    const s = content.text;
    if (s.charCodeAt(0) !== LBRACKET) return null;
    // Label.
    let i = 1;
    let labelLength = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === BACKSLASH && i + 1 < s.length) {
        i += 2;
        labelLength += 2;
        continue;
      }
      if (c === LBRACKET) return null;
      if (c === RBRACKET) break;
      i++;
      labelLength++;
    }
    if (i >= s.length || labelLength > 999) return null;
    const label = s.slice(1, i);
    if (label.trim() === "" || label.charCodeAt(0) === CARET) return null;
    if (s.charCodeAt(i + 1) !== COLON) return null;
    i += 2;
    i = skipSpacesAndOneEol(s, i);
    // Destination.
    let destStart = i;
    let destEnd = i;
    if (s.charCodeAt(i) === 60) {
      let j = i + 1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === BACKSLASH && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (c === 62 || c === 60 || c === LF || c === CR) break;
        j++;
      }
      if (s.charCodeAt(j) !== 62) return null;
      destStart = i + 1;
      destEnd = j;
      i = j + 1;
    } else {
      let depth = 0;
      let j = i;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === BACKSLASH && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (c <= SPACE || c === 127) break;
        if (c === 40) depth++;
        else if (c === 41) {
          if (depth === 0) break;
          depth--;
        }
        j++;
      }
      if (j === i || depth !== 0) return null;
      destStart = i;
      destEnd = j;
      i = j;
    }
    const authored = s.slice(destStart, destEnd);
    const url =
      isWindowsAbsolutePath(authored) && !authored.includes("&") ? authored : unescapeString(authored);
    // Optional title, which must be separated by whitespace.
    const beforeTitle = i;
    let j = skipSpacesAndOneEol(s, i);
    let title: string | null = null;
    let end = beforeTitle;
    const q = s.charCodeAt(j);
    if ((q === 34 || q === 39 || q === 40) && j > beforeTitle) {
      const close = q === 40 ? 41 : q;
      let k = j + 1;
      while (k < s.length) {
        const c = s.charCodeAt(k);
        if (c === BACKSLASH && k + 1 < s.length) {
          k += 2;
          continue;
        }
        if (c === close) break;
        if (q === 40 && c === 40) {
          k = s.length;
          break;
        }
        k++;
      }
      if (k < s.length && !/\n[ \t]*\n/.test(s.slice(j, k))) {
        let m = k + 1;
        while (isSpaceOrTab(s.charCodeAt(m))) m++;
        if (m >= s.length || s.charCodeAt(m) === LF || s.charCodeAt(m) === CR) {
          title = unescapeString(s.slice(j + 1, k));
          end = m;
          j = m;
        }
      }
    }
    if (title === null) {
      let m = beforeTitle;
      while (isSpaceOrTab(s.charCodeAt(m))) m++;
      if (m < s.length && s.charCodeAt(m) !== LF && s.charCodeAt(m) !== CR) return null;
      j = m;
      end = m;
    }
    // Lines used: up to the line ending after the definition.
    let used = 0;
    for (let k = 0; k < lines.length; k++) {
      if (content.contentStarts[k]! <= j) used = k + 1;
    }
    const atLineEnd = j >= s.length || s.charCodeAt(j) === LF || s.charCodeAt(j) === CR;
    if (!atLineEnd) return null;
    const identifier = normalizeIdentifier(label);
    return {
      definition: {
        start: this.mapContent(content, 0),
        end: this.mapContentEnd(content, end),
        label: unescapeString(label),
        identifier,
        url,
        title,
      },
      lines: j >= s.length ? lines.length : used,
    };
  }

  startFootnoteDefinition(): boolean {
    const b = this.blocks;
    const s = this.source;
    const at = b.nextNonspace;
    if (s.charCodeAt(at + 1) !== CARET) return false;
    let i = at + 2;
    while (i < b.lineEnd) {
      const c = s.charCodeAt(i);
      if (c === RBRACKET) break;
      if (c === LBRACKET || isWhitespaceCode(c)) return false;
      if (c === BACKSLASH) i++;
      i++;
    }
    if (i >= b.lineEnd || i === at + 2 || s.charCodeAt(i + 1) !== COLON) return false;
    const label = s.slice(at + 2, i);
    b.closeUnmatchedBlocks();
    const definition = b.addChild("footnoteDefinition", at);
    definition.label = label;
    this.definitions.footnotes.add(normalizeIdentifier(label));
    b.advanceNextNonspace();
    b.advanceOffset(i + 2 - at, false);
    while (isSpaceOrTab(b.code(b.offset))) b.advanceOffset(1, true);
    return true;
  }

  startLeafDirective(): boolean {
    const b = this.blocks;
    const s = this.source;
    const at = b.nextNonspace;
    const name = "artifact-template";
    if (!s.startsWith(`::${name}`, at)) return false;
    let i = at + 2 + name.length;
    const after = s.charCodeAt(i);
    if (i < b.lineEnd && after !== LBRACKET && after !== 123 && !isSpaceOrTab(after)) return false;
    let labelRange: [number, number] | undefined;
    if (after === LBRACKET) {
      const close = s.indexOf("]", i);
      if (close < 0 || close > b.lineEnd) return false;
      labelRange = [i + 1, close];
      i = close + 1;
    }
    let attributes: Record<string, string> = {};
    if (s.charCodeAt(i) === 123) {
      const parsed = parseDirectiveAttributes(s.slice(0, b.lineEnd), i);
      if (!parsed) return false;
      attributes = parsed.attributes;
      i = parsed.end;
    }
    while (isSpaceOrTab(s.charCodeAt(i)) && i < b.lineEnd) i++;
    if (i !== b.lineEnd) return false;
    b.closeUnmatchedBlocks();
    const block = b.addChild("leafDirective", at) as DirectiveBlock;
    block.name = name;
    block.attributes = attributes;
    block.labelRange = labelRange;
    block.end = b.lineEnd;
    b.advanceOffset(b.lineEnd - b.offset, false);
    return true;
  }

  /** A GFM delimiter row under a paragraph line with as many cells starts a table. */
  startTable(container: Block): boolean {
    const b = this.blocks;
    if (container.type !== "paragraph" || b.tip !== container) return false;
    const s = this.source;
    const rowStart = b.nextNonspace;
    const align = parseDelimiterRow(s, rowStart, b.lineEnd);
    if (!align) return false;
    const header = container.lines.at(-1)!;
    const headerCells = splitRow(s, header.start, header.end);
    if (headerCells.length !== align.length) return false;
    // Lines before the header stay a paragraph.
    const before = container.lines.slice(0, -1);
    const parent = container.parent!;
    if (before.length > 0) {
      container.lines = before;
      container.end = before.at(-1)!.end;
      b.finalize(container, container.end);
    } else {
      parent.children.pop();
      b.tip = parent;
    }
    const table = newBlock("table", header.start) as TableBlock;
    table.parent = parent;
    parent.children.push(table);
    b.tip = table;
    table.align = align;
    table.lines.push(header, { start: rowStart, end: b.lineEnd, pad: 0 });
    table.openingLine = true;
    table.end = b.lineEnd;
    b.advanceOffset(b.lineEnd - b.offset, false);
    return true;
  }

  // --- Conversion to mdast ------------------------------------------------------------------

  contentOf(lines: ReadonlyArray<ContentLine>): Content {
    const s = this.source;
    let text = "";
    const contentStarts: number[] = [];
    const sourceStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Continuation lines keep their indentation: inline parsing skips it, labels keep it.
      const start = i > 0 && line.indent !== undefined ? line.indent : line.start;
      contentStarts.push(text.length);
      sourceStarts.push(start);
      text += s.slice(start, line.end);
      if (i < lines.length - 1) {
        // Keep the line ending as written.
        let eol = line.end;
        if (s.charCodeAt(eol) === CR && s.charCodeAt(eol + 1) === LF) text += "\r\n";
        else text += s[eol] ?? "\n";
        void eol;
      }
    }
    return { text, contentStarts, sourceStarts };
  }

  mapContent(content: Content, index: number): number {
    const { contentStarts, sourceStarts } = content;
    let lo = 0;
    for (let i = 0; i < contentStarts.length; i++) if (contentStarts[i]! <= index) lo = i;
    return sourceStarts[lo]! + (index - contentStarts[lo]!);
  }

  mapContentEnd(content: Content, index: number): number {
    return index <= 0 ? this.mapContent(content, 0) : this.mapContent(content, index - 1) + 1;
  }

  inlines(lines: ReadonlyArray<ContentLine>): PhrasingContent[] {
    if (lines.length === 0) return [];
    const content = this.contentOf(lines);
    const children = new InlineParser(this.source, content, this.definitions, { math: this.math, directives: true }, this).parse();
    // mdast-util-gfm-table: escaped pipes in table code spans lose their backslash.
    if (this.inTable) unescapeTableCode(children);
    return children;
  }

  convertChildren(block: Block): RootContent[] {
    const out: RootContent[] = [];
    for (const child of block.children) this.convertBlock(child, out);
    return out;
  }

  convertBlock(block: Block, out: RootContent[]) {
    const s = this.source;
    switch (block.type) {
      case "paragraph": {
        const paragraph = block as ParagraphBlock;
        for (const definition of paragraph.definitions ?? []) {
          out.push({
            type: "definition",
            identifier: definition.identifier.toLowerCase(),
            label: definition.label,
            title: definition.title,
            url: definition.url,
            position: this.position(definition.start, definition.end),
          } as Definition);
        }
        if (block.lines.length === 0) return;
        const lines = trimTrailing(s, block.lines);
        out.push({
          type: "paragraph",
          children: this.inlines(lines),
          position: this.position(block.lines[0]!.start, block.lines.at(-1)!.end),
        } as Paragraph);
        return;
      }
      case "heading": {
        const lines = block.setext ? trimTrailing(s, block.lines) : block.lines;
        out.push({
          type: "heading",
          depth: block.depth as 1 | 2 | 3 | 4 | 5 | 6,
          children: this.inlines(lines),
          position: this.position(block.start, block.end),
        });
        return;
      }
      case "thematicBreak":
        out.push({ type: "thematicBreak", position: this.position(block.start, block.end) });
        return;
      case "code": {
        if (block.fenced) {
          const info = s.slice(block.infoStart, block.infoEnd).trim();
          const space = info.search(/[ \t]/);
          const lang = info === "" ? null : unescapeString(space < 0 ? info : info.slice(0, space));
          const meta = space < 0 ? null : unescapeString(info.slice(space + 1).trim()) || null;
          out.push({
            type: "code",
            lang,
            meta,
            value: this.joinLines(block.lines),
            position: this.position(block.start, this.openBlockEnd(block)),
          });
          return;
        }
        let count = block.lines.length;
        while (count > 0 && block.lines[count - 1]!.weak) count--;
        const codeLines = block.lines.slice(0, count);
        let value = this.joinLines(codeLines);
        // micromark keeps all but the last line ending of trailing indented blank lines.
        if (codeLines.length > 1 && codeLines.at(-1)!.start === codeLines.at(-1)!.end && codeLines.at(-1)!.pad === 0) {
          value = value.slice(0, -1);
        }
        out.push({
          type: "code",
          lang: null,
          meta: null,
          value,
          position: this.position(block.start, codeLines.at(-1)?.end ?? block.end),
        });
        return;
      }
      case "math": {
        const info = s.slice(block.infoStart, block.infoEnd).trim();
        const value = this.joinLines(block.lines);
        out.push({
          type: "math",
          meta: info || null,
          position: this.position(block.start, this.openBlockEnd(block)),
          value,
          data: {
            hName: "pre",
            hChildren: [
              {
                type: "element",
                tagName: "code",
                properties: { className: ["language-math", "math-display"] },
                children: [{ type: "text", value }],
              },
            ],
          },
        } as unknown as RootContent);
        return;
      }
      case "html": {
        let count = block.lines.length;
        while (count > 1 && block.htmlType >= 6 && s.slice(block.lines[count - 1]!.start, block.lines[count - 1]!.end).trim() === "") count--;
        const lines = block.lines.slice(0, count);
        const last = lines.at(-1)!;
        const end = block.closed || block.htmlType >= 6 ? last.end : this.openBlockEnd(block);
        out.push({
          type: "html",
          value: this.joinLines(lines) + s.slice(last.end, end),
          position: this.position(block.start, end),
        });
        return;
      }
      case "blockquote": {
        const children = this.convertChildren(block) as BlockContent[];
        out.push({
          type: "blockquote",
          children,
          position: this.position(block.start, Math.max(endOf(children, block.end), block.lastMatchedEnd)),
        });
        return;
      }
      case "list": {
        const items: ListItem[] = [];
        for (const child of block.children) items.push(this.convertListItem(child));
        out.push({
          type: "list",
          ordered: block.ordered,
          start: block.ordered ? block.listStart : null,
          spread: block.spreadBlank,
          children: items,
          position: this.position(block.start, endOf(items, block.end)),
        } as List);
        return;
      }
      case "footnoteDefinition": {
        const children = this.convertChildren(block) as BlockContent[];
        out.push({
          type: "footnoteDefinition",
          identifier: normalizeIdentifier(block.label).toLowerCase(),
          label: block.label,
          children,
          position: this.position(block.start, endOf(children, block.end)),
        } as FootnoteDefinition);
        return;
      }
      case "table": {
        out.push(this.convertTable(block as TableBlock));
        return;
      }
      case "leafDirective": {
        const directive = block as DirectiveBlock;
        out.push({
          type: "leafDirective",
          name: directive.name,
          attributes: directive.attributes,
          children: directive.labelRange
            ? this.inlines([{ start: directive.labelRange[0], end: directive.labelRange[1], pad: 0 }])
            : [],
          position: this.position(block.start, block.end),
        } as unknown as RootContent);
        return;
      }
      default:
        return;
    }
  }

  /** Lines of literal content, joined by the line endings they had. */
  joinLines(lines: ReadonlyArray<ContentLine>): string {
    const s = this.source;
    let value = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i > 0) {
        const previous = lines[i - 1]!.end;
        value += s.charCodeAt(previous) === CR && s.charCodeAt(previous + 1) === LF ? "\r\n" : (s[previous] ?? "\n");
      }
      value += " ".repeat(line.pad) + s.slice(line.start, line.end);
    }
    return value;
  }

  /** An unclosed fence or HTML block that the document ended runs to the end, line ending too. */
  openBlockEnd(block: Block): number {
    if (block.closed) return block.end;
    const last = block.lines.at(-1);
    const end = last ? last.end : block.end;
    let after = end;
    if (this.source.charCodeAt(after) === CR) after++;
    if (this.source.charCodeAt(after) === LF) after++;
    return after === this.source.length ? after : Math.max(end, block.end);
  }

  convertListItem(block: Block): ListItem {
    const children = this.convertChildren(block) as BlockContent[];
    let checked: boolean | null = null;
    const first = children[0];
    if (first?.type === "paragraph" && first.position!.start.line === this.point(block.start).line) {
      const head = first.children[0];
      // micromark-extension-gfm-task-list-item: whitespace, then more than the end of input.
      const match = head?.type === "text" ? /^\[([ \t]|[xX])\][ \t]+/.exec(head.value) : null;
      if (head?.type === "text" && match && (match[0].length < head.value.length || first.children.length > 1)) {
        checked = match[1] !== " " && match[1] !== "\t";
        // mdast-util-gfm-task-list-item drops the check and one whitespace character.
        head.value = head.value.slice(4);
        if (head.value.length === 0) {
          first.children.shift();
        } else {
          head.position!.start = this.point(head.position!.start.offset! + 4);
          first.position!.start = { ...head.position!.start };
        }
      }
    }
    return {
      type: "listItem",
      spread: block.spreadBlank,
      checked,
      children,
      position: this.position(block.start, endOf(children, block.end)),
    };
  }

  convertTable(block: TableBlock): Table {
    this.inTable = true;
    try {
      return this.convertTableRows(block);
    } finally {
      this.inTable = false;
    }
  }

  inTable = false;

  convertTableRows(block: TableBlock): Table {
    const s = this.source;
    const rows: TableRow[] = [];
    block.lines.forEach((line, index) => {
      if (index === 1) return;
      const cells: TableCell[] = splitRow(s, line.start, line.end).map(([start, end, cellStart, cellEnd]) => ({
        type: "tableCell",
        children: this.inlines(start < end ? [{ start, end, pad: 0 }] : []),
        position: this.position(cellStart, cellEnd),
      }));
      rows.push({
        type: "tableRow",
        children: cells,
        position: this.position(line.start, trimEnd(s, line.start, line.end)),
      });
    });
    const last = block.lines.at(-1)!;
    return {
      type: "table",
      align: block.align!,
      children: rows,
      position: this.position(block.start, trimEnd(s, last.start, last.end)),
    };
  }
}

function unescapeTableCode(nodes: PhrasingContent[]) {
  for (const node of nodes) {
    if (node.type === "inlineCode") node.value = node.value.replace(/\\([\\|])/g, (all, char) => (char === "|" ? char : all));
    else if ("children" in node) unescapeTableCode(node.children as PhrasingContent[]);
  }
}

function endOf(children: ReadonlyArray<{ position?: Position | undefined }>, fallback: number) {
  return children.at(-1)?.position?.end.offset ?? fallback;
}

function trimEnd(s: string, start: number, end: number): number {
  let e = end;
  while (e > start && isSpaceOrTab(s.charCodeAt(e - 1))) e--;
  return e;
}

function trimTrailing(s: string, lines: ContentLine[]): ContentLine[] {
  const last = lines.at(-1)!;
  const end = trimEnd(s, last.start, last.end);
  return end === last.end ? lines : [...lines.slice(0, -1), { ...last, end }];
}

function skipSpacesAndOneEol(s: string, at: number): number {
  let i = at;
  while (isSpaceOrTab(s.charCodeAt(i))) i++;
  if (s.charCodeAt(i) === CR && s.charCodeAt(i + 1) === LF) i += 2;
  else if (s.charCodeAt(i) === LF || s.charCodeAt(i) === CR) i++;
  while (isSpaceOrTab(s.charCodeAt(i))) i++;
  return i;
}

/** Alignments of a GFM delimiter row, or null when the line is not one. */
function parseDelimiterRow(
  s: string,
  start: number,
  end: number,
): Array<"left" | "right" | "center" | null> | null {
  const align: Array<"left" | "right" | "center" | null> = [];
  let i = start;
  let sawPipe = false;
  if (s.charCodeAt(i) === PIPE) {
    sawPipe = true;
    i++;
  }
  while (true) {
    while (i < end && isSpaceOrTab(s.charCodeAt(i))) i++;
    if (i >= end) break;
    let left = false;
    let right = false;
    if (s.charCodeAt(i) === COLON) {
      left = true;
      i++;
    }
    let dashes = 0;
    while (i < end && s.charCodeAt(i) === DASH) {
      dashes++;
      i++;
    }
    if (dashes === 0) return null;
    if (s.charCodeAt(i) === COLON) {
      right = true;
      i++;
    }
    while (i < end && isSpaceOrTab(s.charCodeAt(i))) i++;
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
    if (i >= end) break;
    if (s.charCodeAt(i) !== PIPE) return null;
    sawPipe = true;
    i++;
  }
  if (align.length === 0 || (!sawPipe && align.length < 2)) return sawPipe ? align : null;
  return align;
}

/** Cells of a table row: [contentStart, contentEnd, cellStart, cellEnd] source ranges. */
function splitRow(s: string, start: number, lineEnd: number): Array<[number, number, number, number]> {
  const end = trimEnd(s, start, lineEnd);
  const cells: Array<[number, number, number, number]> = [];
  let i = start;
  if (s.charCodeAt(i) === PIPE) i++;
  let cellStart = start;
  let contentStart = i;
  while (i <= end) {
    const c = i < end ? s.charCodeAt(i) : -1;
    if (c === BACKSLASH && i + 1 < end) {
      i += 2;
      continue;
    }
    if (c === PIPE || i === end) {
      let a = contentStart;
      let b = i;
      while (a < b && isSpaceOrTab(s.charCodeAt(a))) a++;
      while (b > a && isSpaceOrTab(s.charCodeAt(b - 1))) b--;
      // A cell runs from its leading pipe to the next; the last one keeps the closing pipe.
      const closesRow = c === PIPE && i + 1 >= end;
      const cellEnd = closesRow ? i + 1 : i;
      if (!(i === end && contentStart === end && cells.length > 0)) {
        cells.push([a, b, cellStart, cellEnd]);
      }
      cellStart = c === PIPE ? i : i;
      contentStart = i + 1;
      if (i === end) break;
    }
    i++;
  }
  return cells;
}

void TAB;
