// CommonMark block structure, as the spec's parsing strategy describes it: each line first
// continues the open containers, then may open new blocks, and the rest is leaf content.
// Character-code scanning only, so the structure ports to WebAssembly unchanged.

export const TAB = 9;
export const LF = 10;
export const CR = 13;
export const SPACE = 32;
export const BANG = 33;
export const QUOTE = 34;
export const HASH = 35;
export const DOLLAR = 36;
export const AMP = 38;
export const APOS = 39;
export const LPAREN = 40;
export const RPAREN = 41;
export const STAR = 42;
const PLUS = 43;
export const DASH = 45;
const DOT = 46;
const SLASH = 47;
export const COLON = 58;
export const SEMI = 59;
export const LT = 60;
const EQ = 61;
export const GT = 62;
export const LBRACKET = 91;
export const BACKSLASH = 92;
export const RBRACKET = 93;
export const CARET = 94;
export const UNDERSCORE = 95;
export const BACKTICK = 96;
export const LBRACE = 123;
export const PIPE = 124;
export const RBRACE = 125;
export const TILDE = 126;

export type BlockType =
  | "root"
  | "blockquote"
  | "list"
  | "listItem"
  | "paragraph"
  | "heading"
  | "thematicBreak"
  | "code"
  | "html"
  | "table"
  | "footnoteDefinition"
  | "math"
  | "leafDirective";

/** One line of leaf content: a source range, after `pad` columns left over from a tab. */
export interface ContentLine {
  start: number;
  end: number;
  pad: number;
  /** In indented code, a blank line indented less than a code line; trailing ones are not code. */
  weak?: boolean;
  /** Paragraph lines: where the line's indentation starts, which labels keep. */
  indent?: number;
}

export interface Block {
  type: BlockType;
  parent: Block | null;
  children: Block[];
  open: boolean;
  start: number;
  end: number;
  lines: ContentLine[];
  /** The last line this block saw was blank. */
  lastLineBlank: boolean;
  // Lists and items.
  ordered: boolean;
  bulletChar: number;
  listStart: number;
  markerOffset: number;
  padding: number;
  /** Spread, as mdast decides it. */
  spreadBlank: boolean;
  /** A blank line not yet followed by content. */
  pendingBlank: boolean;
  /** End of the last line a quote matched, blank or not. */
  lastMatchedEnd: number;
  // Code, math and HTML.
  fenced: boolean;
  fenceChar: number;
  fenceLength: number;
  fenceOffset: number;
  infoStart: number;
  infoEnd: number;
  closed: boolean;
  /** The fence opened on this line, which holds no content. */
  openingLine: boolean;
  htmlType: number;
  // Headings.
  depth: number;
  setext: boolean;
  // Footnote definitions.
  label: string;
  labelStart: number;
  labelEnd: number;
}

export function newBlock(type: BlockType, start: number): Block {
  return {
    type,
    parent: null,
    children: [],
    open: true,
    start,
    end: start,
    lines: [],
    lastLineBlank: false,
    ordered: false,
    bulletChar: 0,
    listStart: 1,
    markerOffset: 0,
    padding: 0,
    spreadBlank: false,
    pendingBlank: false,
    lastMatchedEnd: -1,
    fenced: false,
    fenceChar: 0,
    fenceLength: 0,
    fenceOffset: 0,
    infoStart: 0,
    infoEnd: 0,
    closed: false,
    openingLine: false,
    htmlType: 0,
    depth: 0,
    setext: false,
    label: "",
    labelStart: 0,
    labelEnd: 0,
  };
}

export const isSpaceOrTab = (code: number) => code === SPACE || code === TAB;
const isLineEnding = (code: number) => code === LF || code === CR;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isAsciiAlpha = (code: number) => (code | 32) >= 97 && (code | 32) <= 122;

const CODE_INDENT = 4;

// HTML block start conditions 1 and 6 by tag name.
const HTML_RAW_TAGS = ["pre", "script", "style", "textarea"];
const HTML_BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details " +
    "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
    "head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p " +
    "param search section summary table tbody td tfoot th thead title tr track ul"
  ).split(" "),
);

export interface BlockOptions {
  readonly math: boolean;
  readonly directives: boolean;
}

/** Parses the block structure of `source`; leaf blocks keep source ranges for inline parsing. */
export class BlockParser {
  readonly source: string;
  readonly options: BlockOptions;
  readonly root: Block;
  tip: Block;
  oldTip: Block;
  lastMatchedContainer: Block;
  /** Start offsets of each line, for positions. */
  readonly lineStarts: number[] = [];

  // Per-line state.
  lineStart = 0;
  lineEnd = 0;
  offset = 0;
  column = 0;
  nextNonspace = 0;
  nextNonspaceColumn = 0;
  indent = 0;
  indented = false;
  blank = false;
  partiallyConsumedTab = false;
  allClosed = true;

  constructor(source: string, options: BlockOptions) {
    this.source = source;
    this.options = options;
    this.root = newBlock("root", 0);
    this.tip = this.root;
    this.oldTip = this.root;
    this.lastMatchedContainer = this.root;
  }

  parse(): Block {
    const { source } = this;
    const length = source.length;
    let start = 0;
    while (true) {
      let end = start;
      while (end < length && !isLineEnding(source.charCodeAt(end))) end++;
      this.lineStarts.push(start);
      this.incorporateLine(start, end);
      if (end >= length) break;
      start = end + (source.charCodeAt(end) === CR && source.charCodeAt(end + 1) === LF ? 2 : 1);
      if (start >= length) {
        this.lineStarts.push(start);
        break;
      }
    }
    while (this.tip !== this.root) this.finalize(this.tip, length);
    this.finalize(this.root, length);
    return this.root;
  }

  code(at: number): number {
    return at < this.lineEnd ? this.source.charCodeAt(at) : -1;
  }

  findNextNonspace() {
    let at = this.offset;
    let cols = this.column;
    while (at < this.lineEnd) {
      const c = this.source.charCodeAt(at);
      if (c === SPACE) {
        at++;
        cols++;
      } else if (c === TAB) {
        at++;
        cols += 4 - (cols % 4);
      } else break;
    }
    this.blank = at >= this.lineEnd;
    this.nextNonspace = at;
    this.nextNonspaceColumn = cols;
    this.indent = this.nextNonspaceColumn - this.column;
    this.indented = this.indent >= CODE_INDENT;
  }

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  advanceOffset(count: number, columns: boolean) {
    const { source } = this;
    while (count > 0 && this.offset < this.lineEnd) {
      const c = source.charCodeAt(this.offset);
      if (c === TAB) {
        const charsToTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = charsToTab > count;
          const charsToAdvance = charsToTab > count ? count : charsToTab;
          this.column += charsToAdvance;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          count -= charsToAdvance;
        } else {
          this.partiallyConsumedTab = false;
          this.column += charsToTab;
          this.offset += 1;
          count -= 1;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset += 1;
        this.column += 1;
        count -= 1;
      }
    }
  }

  addChild(type: BlockType, start: number): Block {
    while (!this.canContain(this.tip.type, type)) this.finalize(this.tip, this.lineStart - 1);
    const block = newBlock(type, start);
    block.parent = this.tip;
    this.tip.children.push(block);
    this.tip = block;
    return block;
  }

  canContain(parent: BlockType, child: BlockType): boolean {
    switch (parent) {
      case "root":
      case "blockquote":
      case "listItem":
      case "footnoteDefinition":
        return child !== "listItem";
      case "list":
        return child === "listItem";
      default:
        return false;
    }
  }

  addLine() {
    const pad = this.partiallyConsumedTab ? 4 - (this.column % 4) : 0;
    if (this.partiallyConsumedTab) {
      this.offset += 1;
      this.partiallyConsumedTab = false;
    }
    const line: ContentLine = { start: this.offset, end: this.lineEnd, pad };
    if (this.blank && this.indent < CODE_INDENT) line.weak = true;
    this.tip.lines.push(line);
  }

  closeUnmatchedBlocks() {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatchedContainer) {
      const parent = this.oldTip.parent!;
      this.finalize(this.oldTip, this.lineStart - 1);
      this.oldTip = parent;
    }
    this.allClosed = true;
  }

  /** Whether `block` continues on this line: 0 matched, 1 not matched, 2 matched and the line is done. */
  continues(block: Block): 0 | 1 | 2 {
    switch (block.type) {
      case "blockquote": {
        if (!this.indented && this.code(this.nextNonspace) === GT) {
          this.advanceNextNonspace();
          this.advanceOffset(1, false);
          if (isSpaceOrTab(this.code(this.offset))) this.advanceOffset(1, true);
          return 0;
        }
        return 1;
      }
      case "listItem": {
        if (this.blank) {
          if (block.children.length === 0 && block.lines.length === 0) return 1;
          this.advanceNextNonspace();
          return 0;
        }
        if (this.indent >= block.markerOffset + block.padding) {
          this.advanceOffset(block.markerOffset + block.padding, true);
          return 0;
        }
        return 1;
      }
      case "footnoteDefinition": {
        if (this.blank) {
          this.advanceNextNonspace();
          return 0;
        }
        if (this.indent >= CODE_INDENT) {
          this.advanceOffset(CODE_INDENT, true);
          return 0;
        }
        return 1;
      }
      case "code": {
        if (block.fenced) {
          const match =
            this.indent <= 3 && this.code(this.nextNonspace) === block.fenceChar
              ? this.closingFenceLength(block)
              : 0;
          if (match > 0) {
            block.closed = true;
            block.end = this.lineEnd;
            this.finalize(block, this.lineEnd);
            return 2;
          }
          let i = block.fenceOffset;
          while (i > 0 && isSpaceOrTab(this.code(this.offset))) {
            this.advanceOffset(1, true);
            i--;
          }
          return 0;
        }
        if (this.indent >= CODE_INDENT) {
          this.advanceOffset(CODE_INDENT, true);
          return 0;
        }
        if (this.blank) {
          this.advanceNextNonspace();
          return 0;
        }
        return 1;
      }
      case "math": {
        const match =
          this.indent <= 3 && this.code(this.nextNonspace) === DOLLAR
            ? this.closingFenceLength(block)
            : 0;
        if (match > 0) {
          block.closed = true;
          block.end = this.lineEnd;
          this.finalize(block, this.lineEnd);
          return 2;
        }
        let i = block.fenceOffset;
        while (i > 0 && isSpaceOrTab(this.code(this.offset))) {
          this.advanceOffset(1, true);
          i--;
        }
        return 0;
      }
      case "html":
        return this.blank && (block.htmlType === 6 || block.htmlType === 7) ? 1 : 0;
      case "paragraph":
      case "table":
        return this.blank ? 1 : 0;
      case "list":
        return 0;
      default:
        return 1;
    }
  }

  /** Length of a closing fence for `block` at nextNonspace, or 0. */
  closingFenceLength(block: Block): number {
    let at = this.nextNonspace;
    while (this.code(at) === block.fenceChar) at++;
    const length = at - this.nextNonspace;
    if (length < block.fenceLength) return 0;
    while (isSpaceOrTab(this.code(at))) at++;
    return at === this.lineEnd ? length : 0;
  }

  incorporateLine(start: number, end: number) {
    this.lineStart = start;
    this.lineEnd = end;
    this.offset = start;
    this.column = 0;
    this.blank = false;
    this.partiallyConsumedTab = false;
    this.oldTip = this.tip;

    let container = this.root;
    let allMatched = true;
    while (true) {
      const last = container.children.at(-1);
      if (!last || !last.open) break;
      container = last;
      this.findNextNonspace();
      const result = this.continues(container);
      if (result === 1) {
        container = container.parent!;
        allMatched = false;
        break;
      }
      if (result === 2) {
        this.lastLineLength(end);
        return;
      }
      if (container.type === "blockquote") container.lastMatchedEnd = end;
    }
    this.allClosed = container === this.oldTip;
    this.lastMatchedContainer = container;
    const contentStart = this.offset;

    let matchedLeaf =
      container.type !== "paragraph" &&
      (container.type === "code" ||
        container.type === "html" ||
        container.type === "math" ||
        container.type === "table");

    while (!matchedLeaf) {
      this.findNextNonspace();
      if (!this.indented && !this.mayStartBlock(this.code(this.nextNonspace))) {
        this.advanceNextNonspace();
        break;
      }
      const started = this.tryStart(container);
      if (started === 0) {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      if (started === 2) {
        matchedLeaf = true;
        break;
      }
      if (
        container.type === "code" ||
        container.type === "html" ||
        container.type === "math" ||
        container.type === "thematicBreak" ||
        container.type === "heading" ||
        container.type === "leafDirective"
      ) {
        matchedLeaf = true;
      }
    }

    if (!this.allClosed && !this.blank && this.tip.type === "paragraph" && !allMatched) {
      // Lazy paragraph continuation.
      const indent = contentStart;
      this.advanceNextNonspace();
      this.addLine();
      this.tip.lines.at(-1)!.indent = indent;
      this.lastLineLength(end);
      return;
    }

    this.closeUnmatchedBlocks();
    if (this.blank && container.children.length > 0) {
      container.children.at(-1)!.lastLineBlank = true;
    }
    const t = container.type;
    const lastLineBlank =
      this.blank &&
      !(
        t === "blockquote" ||
        (t === "code" && container.fenced) ||
        t === "math" ||
        (t === "listItem" && container.children.length === 0 && container.start >= start)
      );
    for (let cont: Block | null = container; cont; cont = cont.parent) {
      cont.lastLineBlank = lastLineBlank;
    }
    // The rest of an item's own marker line is not a blank line inside it.
    const atMarker = t === "listItem" && container.start >= start;
    if (this.blank && t === "code" && !container.fenced) {
      // Blank lines in indented code are code only if more code follows.
      container.pendingBlank = true;
    } else if (this.blank && !atMarker && t !== "code" && t !== "math" && t !== "html") {
      this.markBlank(container);
    } else if (!this.blank && t === "code") {
      container.pendingBlank = false;
    }

    switch (t) {
      case "code":
      case "math":
      case "html":
        if (container.openingLine) container.openingLine = false;
        else this.addLine();
        if (t === "html" && this.htmlBlockEnds(container.htmlType)) {
          container.end = end;
          container.closed = true;
          this.finalize(container, end);
        }
        break;
      case "table":
        if (container.openingLine) container.openingLine = false;
        else if (!this.blank) {
          this.advanceNextNonspace();
          this.addLine();
        }
        break;
      case "paragraph":
        if (!this.blank) {
          const indent = contentStart;
          this.advanceNextNonspace();
          this.addLine();
          this.tip.lines.at(-1)!.indent = indent;
        }
        break;
      case "thematicBreak":
      case "heading":
      case "leafDirective":
        break;
      default:
        if (!this.blank) {
          this.advanceNextNonspace();
          const paragraph = this.addChild("paragraph", this.offset);
          this.addLine();
          paragraph.end = end;
        }
    }
    this.lastLineLength(end);
  }

  lastLineLength(end: number) {
    if (this.tip.open) this.tip.end = end;
    if (!this.blank) this.markContent(this.tip);
  }

  /**
   * As mdast-util-from-markdown decides `spread`: a blank line belongs to the deepest matched
   * list item with no nested list or quote matched inside it, or to the list between items.
   */
  markBlank(container: Block) {
    for (let block: Block | null = container; block; block = block.parent) {
      if (block.type === "listItem" || block.type === "list") {
        block.pendingBlank = true;
        return;
      }
      if (block.type === "blockquote") return;
    }
  }

  /** Content arrived in `container`: blank lines before it inside its items spread them. */
  markContent(container: Block) {
    for (let block: Block | null = container; block; block = block.parent) {
      if (block.type === "listItem" && block.pendingBlank) {
        block.spreadBlank = true;
        block.pendingBlank = false;
      }
    }
  }

  mayStartBlock(c: number): boolean {
    return (
      c === GT ||
      c === HASH ||
      c === BACKTICK ||
      c === TILDE ||
      c === LT ||
      c === STAR ||
      c === PLUS ||
      c === DASH ||
      c === UNDERSCORE ||
      c === EQ ||
      c === PIPE ||
      c === COLON ||
      c === LBRACKET ||
      c === DOLLAR ||
      c === BACKSLASH ||
      isDigit(c)
    );
  }

  /** 0 nothing started, 1 container started, 2 leaf started and the line is consumed. */
  tryStart(container: Block): 0 | 1 | 2 {
    const c = this.code(this.nextNonspace);
    if (this.indented) {
      if (this.tip.type === "paragraph" || this.blank) return 0;
      // Indented code.
      const start = this.offset;
      this.advanceOffset(CODE_INDENT, true);
      this.closeUnmatchedBlocks();
      this.addChild("code", start);
      return 2;
    }
    // A delimiter row under a paragraph line makes a table before anything else starts.
    if (
      (c === PIPE || c === DASH || c === COLON) &&
      container.type === "paragraph" &&
      this.tryTable(container)
    ) {
      return 2;
    }
    switch (c) {
      case GT: {
        this.advanceNextNonspace();
        this.advanceOffset(1, false);
        if (isSpaceOrTab(this.code(this.offset))) this.advanceOffset(1, true);
        this.closeUnmatchedBlocks();
        this.addChild("blockquote", this.nextNonspace);
        return 1;
      }
      case HASH:
        return this.tryAtxHeading() ? 2 : 0;
      case BACKTICK:
      case TILDE:
        return this.tryFence(c) ? 2 : 0;
      case DOLLAR:
        return this.options.math && this.tryMathFence() ? 2 : 0;
      case LT:
        return this.tryHtmlBlock(container) ? 2 : 0;
      case COLON:
        return this.options.directives && this.tryLeafDirective() ? 2 : 0;
      case LBRACKET:
        return this.tryFootnoteDefinition() ? 1 : 0;
      case EQ:
      case DASH:
        if (this.trySetextHeading(container, c)) return 2;
        if (c === DASH && this.tryThematicBreak(c)) return 2;
        if (c === DASH) return this.tryListItem(container) ? 1 : 0;
        return 0;
      case STAR:
      case UNDERSCORE:
        if (this.tryThematicBreak(c)) return 2;
        return c === STAR && this.tryListItem(container) ? 1 : 0;
      case PLUS:
        return this.tryListItem(container) ? 1 : 0;
      case PIPE:
        return this.tryTable(container) ? 2 : 0;
      default:
        if (isDigit(c)) return this.tryListItem(container) ? 1 : 0;
        return this.tryTable(container) ? 2 : 0;
    }
  }

  tryAtxHeading(): boolean {
    let at = this.nextNonspace;
    let depth = 0;
    while (this.code(at) === HASH) {
      at++;
      depth++;
    }
    if (depth > 6) return false;
    const after = this.code(at);
    if (after !== -1 && !isSpaceOrTab(after)) return false;
    this.closeUnmatchedBlocks();
    const heading = this.addChild("heading", this.nextNonspace);
    heading.depth = depth;
    // Content without the opening and closing sequences.
    let contentStart = at;
    while (isSpaceOrTab(this.code(contentStart))) contentStart++;
    let contentEnd = this.lineEnd;
    while (contentEnd > contentStart && isSpaceOrTab(this.source.charCodeAt(contentEnd - 1))) {
      contentEnd--;
    }
    let close = contentEnd;
    while (close > contentStart && this.source.charCodeAt(close - 1) === HASH) close--;
    if (
      close < contentEnd &&
      (close === contentStart || isSpaceOrTab(this.source.charCodeAt(close - 1)))
    ) {
      contentEnd = close;
      while (contentEnd > contentStart && isSpaceOrTab(this.source.charCodeAt(contentEnd - 1))) {
        contentEnd--;
      }
    } else if (close === contentStart && contentEnd > contentStart) {
      contentEnd = contentStart;
    }
    heading.lines.push({ start: contentStart, end: Math.max(contentStart, contentEnd), pad: 0 });
    heading.end = this.lineEnd;
    this.advanceOffset(this.lineEnd - this.offset, false);
    return true;
  }

  tryFence(c: number): boolean {
    let at = this.nextNonspace;
    while (this.code(at) === c) at++;
    const length = at - this.nextNonspace;
    if (length < 3) return false;
    const infoStart = at;
    if (c === BACKTICK) {
      for (let i = at; i < this.lineEnd; i++) {
        if (this.source.charCodeAt(i) === BACKTICK) return false;
      }
    }
    this.closeUnmatchedBlocks();
    const code = this.addChild("code", this.nextNonspace);
    code.fenced = true;
    code.fenceChar = c;
    code.fenceLength = length;
    code.fenceOffset = this.indent;
    code.infoStart = infoStart;
    code.infoEnd = this.lineEnd;
    code.openingLine = true;
    this.advanceOffset(this.lineEnd - this.offset, false);
    return true;
  }

  tryMathFence(): boolean {
    let at = this.nextNonspace;
    while (this.code(at) === DOLLAR) at++;
    const length = at - this.nextNonspace;
    if (length < 2) return false;
    for (let i = at; i < this.lineEnd; i++) {
      if (this.source.charCodeAt(i) === DOLLAR) return false;
    }
    this.closeUnmatchedBlocks();
    const math = this.addChild("math", this.nextNonspace);
    math.fenced = true;
    math.fenceChar = DOLLAR;
    math.fenceLength = length;
    math.fenceOffset = this.indent;
    math.infoStart = at;
    math.infoEnd = this.lineEnd;
    math.openingLine = true;
    this.advanceOffset(this.lineEnd - this.offset, false);
    return true;
  }

  tryThematicBreak(c: number): boolean {
    let count = 0;
    for (let at = this.nextNonspace; at < this.lineEnd; at++) {
      const code = this.source.charCodeAt(at);
      if (code === c) count++;
      else if (!isSpaceOrTab(code)) return false;
    }
    if (count < 3) return false;
    this.closeUnmatchedBlocks();
    const block = this.addChild("thematicBreak", this.nextNonspace);
    block.end = this.lineEnd;
    this.advanceOffset(this.lineEnd - this.offset, false);
    return true;
  }

  trySetextHeading(container: Block, c: number): boolean {
    if (container.type !== "paragraph" || this.tip !== container || !this.allClosedOrLazyOk()) {
      return false;
    }
    let at = this.nextNonspace;
    while (this.code(at) === c) at++;
    while (isSpaceOrTab(this.code(at))) at++;
    if (at !== this.lineEnd) return false;
    const definitionsEnd = this.onSetext(container);
    if (definitionsEnd === null) return false;
    this.closeUnmatchedBlocks();
    const heading = newBlock("heading", container.lines[0]!.start);
    heading.depth = c === EQ ? 1 : 2;
    heading.setext = true;
    heading.lines = container.lines;
    heading.parent = container.parent;
    heading.end = this.lineEnd;
    heading.start = container.start;
    const siblings = container.parent!.children;
    container.lines = [];
    container.open = false;
    siblings.push(heading);
    this.tip = heading;
    this.advanceOffset(this.lineEnd - this.offset, false);
    return true;
  }

  allClosedOrLazyOk(): boolean {
    return true;
  }

  /** Hook for the document parser: strips leading definitions; null when nothing is left. */
  onSetext: (paragraph: Block) => number | null = () => 0;

  tryListItem(container: Block): boolean {
    let at = this.nextNonspace;
    const c = this.code(at);
    let ordered = false;
    let listStart = 1;
    let bulletChar = c;
    if (c === STAR || c === PLUS || c === DASH) {
      at++;
    } else {
      let digits = 0;
      let value = 0;
      while (isDigit(this.code(at)) && digits < 10) {
        value = value * 10 + (this.code(at) - 48);
        at++;
        digits++;
      }
      const delimiter = this.code(at);
      if (digits === 0 || digits > 9 || (delimiter !== DOT && delimiter !== RPAREN)) return false;
      if (container.type === "paragraph" && value !== 1) return false;
      ordered = true;
      listStart = value;
      bulletChar = delimiter;
      at++;
    }
    const afterMarker = this.code(at);
    if (afterMarker !== -1 && !isSpaceOrTab(afterMarker)) return false;
    if (container.type === "paragraph") {
      // An empty item cannot interrupt a paragraph.
      let rest = at;
      while (isSpaceOrTab(this.code(rest))) rest++;
      if (rest === this.lineEnd) return false;
    }

    const markerStart = this.nextNonspace;
    const markerOffset = this.indent;
    this.advanceNextNonspace();
    this.advanceOffset(at - markerStart, true);
    const spacesStartCol = this.column;
    const spacesStartOffset = this.offset;
    do {
      this.advanceOffset(1, true);
    } while (this.column - spacesStartCol < 5 && isSpaceOrTab(this.code(this.offset)));
    const blankItem = this.offset >= this.lineEnd;
    const spacesAfterMarker = this.column - spacesStartCol;
    let padding: number;
    if (spacesAfterMarker >= 5 || spacesAfterMarker < 1 || blankItem) {
      padding = at - markerStart + 1;
      this.column = spacesStartCol;
      this.offset = spacesStartOffset;
      if (isSpaceOrTab(this.code(this.offset))) this.advanceOffset(1, true);
    } else {
      padding = at - markerStart + spacesAfterMarker;
    }

    this.closeUnmatchedBlocks();
    const tip = this.tip;
    if (tip.type !== "list" || tip.ordered !== ordered || tip.bulletChar !== bulletChar) {
      const list = this.addChild("list", markerStart);
      list.ordered = ordered;
      list.bulletChar = bulletChar;
      list.listStart = listStart;
    }
    const list = this.tip;
    const previous = list.children.at(-1);
    if (list.pendingBlank || previous?.pendingBlank) list.spreadBlank = true;
    list.pendingBlank = false;
    if (previous) previous.pendingBlank = false;
    const item = this.addChild("listItem", markerStart);
    item.ordered = ordered;
    item.bulletChar = bulletChar;
    item.markerOffset = markerOffset;
    item.padding = padding;
    return true;
  }

  tryHtmlBlock(container: Block): boolean {
    const type = this.htmlBlockStart(container.type === "paragraph");
    if (type === 0) return false;
    this.closeUnmatchedBlocks();
    const block = this.addChild("html", this.offset);
    block.htmlType = type;
    return true;
  }

  /** The HTML block start condition (1-7) at nextNonspace, or 0. */
  htmlBlockStart(interruptsParagraph: boolean): number {
    const { source } = this;
    const at = this.nextNonspace;
    const rest = source.slice(at + 1, Math.min(this.lineEnd, at + 32)).toLowerCase();
    if (rest.startsWith("!--")) return 2;
    if (rest.startsWith("?")) return 3;
    if (/^![a-z]/.test(rest)) return 4;
    if (rest.startsWith("![cdata[")) return 5;
    for (const tag of HTML_RAW_TAGS) {
      if (rest.startsWith(tag)) {
        const after = rest.charCodeAt(tag.length);
        if (Number.isNaN(after) || after === GT || isSpaceOrTab(after)) return 1;
      }
    }
    const closing = rest.charCodeAt(0) === SLASH;
    let nameStart = closing ? 1 : 0;
    let nameEnd = nameStart;
    while (nameEnd < rest.length && /[a-z0-9]/.test(rest[nameEnd]!)) nameEnd++;
    if (nameEnd > nameStart && isAsciiAlpha(rest.charCodeAt(nameStart))) {
      const name = rest.slice(nameStart, nameEnd);
      const after = rest.charCodeAt(nameEnd);
      if (
        HTML_BLOCK_TAGS.has(name) &&
        (Number.isNaN(after) ||
          after === GT ||
          isSpaceOrTab(after) ||
          (after === SLASH && rest.charCodeAt(nameEnd + 1) === GT))
      ) {
        return 6;
      }
    }
    if (interruptsParagraph) return 0;
    nameStart = 0;
    return this.isCompleteTagLine(at) ? 7 : 0;
  }

  /** Condition 7: a complete open or closing tag alone on the line. */
  isCompleteTagLine(at: number): boolean {
    const end = scanHtmlTag(this.source, at, this.lineEnd, true);
    if (end < 0) return false;
    const { source } = this;
    // Not one of the raw tags.
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(at, end))?.[1]?.toLowerCase();
    if (!name || HTML_RAW_TAGS.includes(name)) return false;
    for (let i = end; i < this.lineEnd; i++) {
      if (!isSpaceOrTab(source.charCodeAt(i))) return false;
    }
    return true;
  }

  htmlBlockEnds(type: number): boolean {
    if (type >= 6) return false;
    const line = this.source.slice(this.lineStart, this.lineEnd);
    switch (type) {
      case 1:
        return /<\/(?:script|pre|style|textarea)>/i.test(line);
      case 2:
        return line.includes("-->");
      case 3:
        return line.includes("?>");
      case 4:
        return line.includes(">");
      case 5:
        return line.includes("]]>");
      default:
        return false;
    }
  }

  tryLeafDirective(): boolean {
    return this.onLeafDirective();
  }

  /** Hook for the document parser, which knows the directive grammar. */
  onLeafDirective: () => boolean = () => false;

  tryFootnoteDefinition(): boolean {
    return this.onFootnoteDefinition();
  }

  onFootnoteDefinition: () => boolean = () => false;

  tryTable(container: Block): boolean {
    return this.onTable(container);
  }

  onTable: (container: Block) => boolean = () => false;

  finalize(block: Block, end: number) {
    if (!block.open) return;
    block.open = false;
    const parent = block.parent;
    if (block.type !== "root" && block.end < block.start) block.end = block.start;
    if (
      end >= 0 &&
      block.lines.length === 0 &&
      block.children.length === 0 &&
      block.end === block.start
    ) {
      block.end = Math.max(block.end, end);
    }
    // Blank lines a nested list ended with lie between the enclosing item's children.
    if (block.pendingBlank && (block.type === "listItem" || block.type === "list") && parent) {
      if (parent.type === "listItem" || parent.type === "list") parent.pendingBlank = true;
    }
    if (block.pendingBlank && block.type === "code" && parent) this.markBlank(parent);
    this.onFinalize(block);
    this.tip = parent ?? this.root;
  }

  onFinalize: (block: Block) => void = () => {};
}

/**
 * End offset of an HTML open or closing tag starting at `at` (a `<`), or -1. With `lineOnly`,
 * the tag must end on this line, as HTML block condition 7 requires.
 */
export function scanHtmlTag(source: string, at: number, end: number, lineOnly: boolean): number {
  if (source.charCodeAt(at) !== LT) return -1;
  let i = at + 1;
  const limit = lineOnly ? end : source.length;
  const closing = source.charCodeAt(i) === SLASH;
  if (closing) i++;
  if (!isAsciiAlpha(source.charCodeAt(i))) return -1;
  while (i < limit) {
    const c = source.charCodeAt(i);
    if (isAsciiAlpha(c) || isDigit(c) || c === DASH) i++;
    else break;
  }
  if (closing) {
    while (i < limit && isWhitespaceCode(source.charCodeAt(i))) i++;
    return source.charCodeAt(i) === GT ? i + 1 : -1;
  }
  while (i < limit) {
    let ws = i;
    while (ws < limit && isWhitespaceCode(source.charCodeAt(ws))) ws++;
    const c = source.charCodeAt(ws);
    if (c === GT) return ws + 1;
    if (c === SLASH) return source.charCodeAt(ws + 1) === GT ? ws + 2 : -1;
    if (ws === i) return -1;
    // Attribute name.
    if (!(isAsciiAlpha(c) || c === UNDERSCORE || c === COLON)) return -1;
    i = ws + 1;
    while (i < limit) {
      const n = source.charCodeAt(i);
      if (
        isAsciiAlpha(n) ||
        isDigit(n) ||
        n === UNDERSCORE ||
        n === DOT ||
        n === COLON ||
        n === DASH
      )
        i++;
      else break;
    }
    // Optional value.
    let v = i;
    while (v < limit && isWhitespaceCode(source.charCodeAt(v))) v++;
    if (source.charCodeAt(v) !== EQ) continue;
    v++;
    while (v < limit && isWhitespaceCode(source.charCodeAt(v))) v++;
    const q = source.charCodeAt(v);
    if (q === QUOTE || q === APOS) {
      const close = source.indexOf(q === QUOTE ? '"' : "'", v + 1);
      if (close < 0 || close >= limit) return -1;
      i = close + 1;
    } else {
      let u = v;
      while (u < limit) {
        const n = source.charCodeAt(u);
        if (
          isWhitespaceCode(n) ||
          n === QUOTE ||
          n === APOS ||
          n === EQ ||
          n === LT ||
          n === GT ||
          n === BACKTICK
        )
          break;
        u++;
      }
      if (u === v) return -1;
      i = u;
    }
  }
  return -1;
}

export const isWhitespaceCode = (c: number) =>
  c === SPACE || c === TAB || c === LF || c === CR || c === 12 || c === 11;
