// CommonMark inlines with GFM strikethrough and footnote calls, inline math and Codex text
// directives, producing mdast phrasing content with micromark's positions.
import type { PhrasingContent } from "mdast";

import {
  APOS,
  BACKSLASH,
  BACKTICK,
  BANG,
  CARET,
  COLON,
  CR,
  DOLLAR,
  GT,
  LBRACE,
  LBRACKET,
  LF,
  LPAREN,
  LT,
  QUOTE,
  RBRACE,
  RBRACKET,
  RPAREN,
  SPACE,
  STAR,
  TAB,
  TILDE,
  UNDERSCORE,
  AMP,
  SEMI,
  HASH,
  scanHtmlTag,
  isWhitespaceCode,
} from "./blocks";
import {
  isGfmAtext,
  matchEmail,
  matchProtocol,
  matchWww,
  previousEmail,
  previousProtocol,
  previousWww,
} from "./autolinks";
import { decodeEntity } from "./entities";
import { type InlineMathMatch, scanDollarMath, scanTexMath } from "./math";

/** Leaf content as one string, with each piece's offset in the source for positions. */
export interface Content {
  readonly text: string;
  /** Content offset where each segment starts, ascending. */
  readonly contentStarts: number[];
  /** Source offset of each segment's first character. */
  readonly sourceStarts: number[];
}

export interface Definitions {
  readonly links: Map<string, { url: string; title: string | null }>;
  readonly footnotes: Set<string>;
}

export interface InlineOptions {
  readonly math: boolean;
  readonly directives: boolean;
  /** Table cells: math may not span lines. */
  readonly mathSingleLine?: boolean;
}

export interface PointFactory {
  point(offset: number): { line: number; column: number; offset: number };
}

export function normalizeIdentifier(value: string): string {
  return value
    .replace(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
    .toLowerCase()
    .toUpperCase();
}

const isAsciiPunctuation = (c: number) =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);

const UNICODE_WHITESPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

/** micromark's classifyCharacter: 1 whitespace, 2 punctuation, 0 other. */
function classify(text: string, at: number): 0 | 1 | 2 {
  if (at < 0 || at >= text.length) return 1;
  const c = text.charCodeAt(at);
  if (c < 128) {
    if (isWhitespaceCode(c) || c === SPACE) return 1;
    return isAsciiPunctuation(c) ? 2 : 0;
  }
  const char = String.fromCodePoint(text.codePointAt(at) ?? c);
  if (UNICODE_WHITESPACE.test(char)) return 1;
  return UNICODE_PUNCTUATION.test(char) ? 2 : 0;
}

function classifyBefore(text: string, at: number): 0 | 1 | 2 {
  if (at <= 0) return 1;
  const c = text.charCodeAt(at - 1);
  // A low surrogate: classify the whole code point.
  if (c >= 0xdc00 && c <= 0xdfff && at >= 2) return classify(text, at - 2);
  return classify(text, at - 1);
}

interface InlineNode {
  kind: "node" | "text" | "delim" | "bracket";
  /** Source offsets. */
  start: number;
  end: number;
  node?: PhrasingContent;
  value?: string;
  // Delimiters.
  char?: number;
  count?: number;
  origCount?: number;
  canOpen?: boolean;
  canClose?: boolean;
  // Brackets.
  image?: boolean;
  active?: boolean;
  contentStart?: number;
  prev: InlineNode | null;
  next: InlineNode | null;
}

interface Delimiter {
  node: InlineNode;
  prev: Delimiter | null;
  next: Delimiter | null;
}

interface Bracket {
  node: InlineNode;
  prev: Bracket | null;
  prevDelimiter: Delimiter | null;
  image: boolean;
  active: boolean;
  /** Content offset just after the `[`. */
  index: number;
  bracketAfter: boolean;
}

export class InlineParser {
  readonly content: Content;
  readonly s: string;
  readonly definitions: Definitions;
  readonly options: InlineOptions;
  readonly points: PointFactory;
  readonly source: string;
  pos = 0;
  head: InlineNode | null = null;
  tail: InlineNode | null = null;
  delimiters: Delimiter | null = null;
  brackets: Bracket | null = null;
  segment = 0;

  constructor(
    source: string,
    content: Content,
    definitions: Definitions,
    options: InlineOptions,
    points: PointFactory,
  ) {
    this.source = source;
    this.content = content;
    this.s = content.text;
    this.definitions = definitions;
    this.options = options;
    this.points = points;
  }

  /** Source offset of a content offset. */
  src(index: number): number {
    const { contentStarts, sourceStarts } = this.content;
    let lo = 0;
    let hi = contentStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (contentStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return sourceStarts[lo]! + (index - contentStarts[lo]!);
  }

  /** Source offset just past the content character at index - 1. */
  srcEnd(index: number): number {
    return index <= 0 ? this.src(0) : this.src(index - 1) + 1;
  }

  position(start: number, end: number) {
    return { start: this.points.point(start), end: this.points.point(end) };
  }

  append(node: InlineNode): InlineNode {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    return node;
  }

  appendText(value: string, start: number, end: number) {
    const tail = this.tail;
    if (tail && tail.kind === "text") {
      tail.value += value;
      tail.end = end;
      return;
    }
    this.append({ kind: "text", start, end, value, prev: null, next: null });
  }

  appendNode(node: PhrasingContent, start: number, end: number) {
    this.append({ kind: "node", start, end, node, prev: null, next: null });
  }

  parse(): PhrasingContent[] {
    const { s } = this;
    const length = s.length;
    let textStart = 0;
    const flush = (until: number) => {
      if (until > textStart) {
        this.appendText(s.slice(textStart, until), this.src(textStart), this.srcEnd(until));
      }
    };
    const email = s.includes("@");
    const www = /www\./i.test(s);
    const http = /https?:\/\//i.test(s);
    while (this.pos < length) {
      const c = s.charCodeAt(this.pos);
      if ((email || www || http) && this.brackets === null) {
        const end = this.matchLiteralAutolink(c, email, www, http);
        if (end > 0) {
          flush(this.pos);
          this.appendLiteralAutolink(this.pos, end);
          this.pos = end;
          textStart = end;
          continue;
        }
      }
      if (!this.isSpecial(c)) {
        this.pos++;
        continue;
      }
      const before = this.pos;
      flush(before);
      if (!this.parseSpecial(c)) {
        // Not a construct: the character is text.
        this.pos = before + 1;
        textStart = before;
        continue;
      }
      textStart = this.pos;
    }
    flush(length);
    this.processEmphasis(null);
    return this.finish(this.head, null);
  }

  /** micromark's literal autolink constructs at this character: the end, or -1. */
  matchLiteralAutolink(c: number, email: boolean, www: boolean, http: boolean): number {
    const { s } = this;
    const at = this.pos;
    const previous = at > 0 ? s.charCodeAt(at - 1) : -1;
    if (email && isGfmAtext(c) && previousEmail(previous)) {
      const end = matchEmail(s, at);
      if (end > 0) return end;
    }
    if (www && (c | 32) === 119 && previousWww(previous)) return matchWww(s, at);
    if (http && (c | 32) === 104 && previousProtocol(previous)) return matchProtocol(s, at);
    return -1;
  }

  appendLiteralAutolink(start: number, end: number) {
    const value = this.s.slice(start, end);
    const url =
      value.includes("@") && !/^(?:https?:\/\/|www\.)/i.test(value)
        ? `mailto:${value}`
        : /^www\./i.test(value)
          ? `http://${value}`
          : value;
    const position = this.position(this.src(start), this.srcEnd(end));
    this.appendNode(
      {
        type: "link",
        title: null,
        url,
        children: [{ type: "text", value, position }],
      } as PhrasingContent,
      this.src(start),
      this.srcEnd(end),
    );
  }

  isSpecial(c: number): boolean {
    if (c >= 128) return false;
    const kind = SPECIAL[c]!;
    return (
      kind === 1 || (kind === 2 && this.options.math) || (kind === 3 && this.options.directives)
    );
  }

  parseSpecial(c: number): boolean {
    switch (c) {
      case LF:
      case CR:
        return this.parseLineEnding();
      case BACKSLASH:
        return this.parseBackslash();
      case BACKTICK:
        return this.parseCodeSpan();
      case STAR:
      case UNDERSCORE:
      case TILDE:
        return this.parseDelimiterRun(c);
      case LBRACKET:
        return this.parseOpenBracket(false);
      case BANG:
        if (this.s.charCodeAt(this.pos + 1) !== LBRACKET) return false;
        return this.parseOpenBracket(true);
      case RBRACKET:
        return this.parseCloseBracket();
      case LT:
        return this.parseAutolink() || this.parseInlineHtml();
      case AMP:
        return this.parseEntity();
      case DOLLAR:
        return this.parseMath();
      case COLON:
        return this.parseTextDirective();
      default:
        return false;
    }
  }

  parseLineEnding(): boolean {
    const { s } = this;
    const at = this.pos;
    const eolLength = s.charCodeAt(at) === CR && s.charCodeAt(at + 1) === LF ? 2 : 1;
    // Trailing spaces before the line ending: two or more make a hard break.
    const tail = this.tail;
    let spaces = 0;
    if (tail && tail.kind === "text" && tail.end === this.src(at)) {
      const value = tail.value!;
      let i = value.length;
      while (i > 0 && (value.charCodeAt(i - 1) === SPACE || value.charCodeAt(i - 1) === TAB)) i--;
      spaces = value.length - i;
      if (spaces > 0) {
        const hasTab = value.slice(i).includes("\t");
        const trailingSpaces = value.length - i;
        tail.value = value.slice(0, i);
        tail.end -= trailingSpaces;
        if (trailingSpaces >= 2 && !hasTab && /^ +$/.test(value.slice(i))) {
          if (tail.value === "") this.remove(tail);
          const breakStart = this.src(at) - trailingSpaces;
          this.pos = at + eolLength;
          this.skipLeadingSpace();
          this.appendNode(
            { type: "break" } as PhrasingContent,
            breakStart,
            this.src(at) + eolLength,
          );
          return true;
        }
        if (tail.value === "") this.remove(tail);
      }
    }
    this.pos = at + eolLength;
    this.appendText(s.slice(at, at + eolLength), this.src(at), this.src(at) + eolLength);
    this.skipLeadingSpace();
    return true;
  }

  skipLeadingSpace() {
    const { s } = this;
    while (
      this.pos < s.length &&
      (s.charCodeAt(this.pos) === SPACE || s.charCodeAt(this.pos) === TAB)
    ) {
      this.pos++;
    }
  }

  remove(node: InlineNode) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }

  parseBackslash(): boolean {
    const { s } = this;
    const at = this.pos;
    const next = s.charCodeAt(at + 1);
    if (next === LF || next === CR) {
      const eol = next === CR && s.charCodeAt(at + 2) === LF ? 2 : 1;
      this.pos = at + 1 + eol;
      this.skipLeadingSpace();
      this.appendNode({ type: "break" } as PhrasingContent, this.src(at), this.src(at + 1) + eol);
      return true;
    }
    if (this.options.math && (next === LPAREN || next === LBRACKET) && this.parseTexMath()) {
      return true;
    }
    if (isAsciiPunctuation(next)) {
      this.pos = at + 2;
      this.appendEscaped(s[at + 1]!, this.src(at), this.src(at + 1) + 1);
      return true;
    }
    return false;
  }

  /** Hook: Windows-path escapes keep their backslash. */
  appendEscaped(char: string, start: number, end: number) {
    const tail = this.tail;
    const before = tail && tail.kind === "text" && tail.end === start ? tail.value! : "";
    if (UNFINISHED_DRIVE_PATH.test(before)) {
      this.appendText(`\\${char}`, start, end);
      return;
    }
    this.appendText(char, start, end);
  }

  parseCodeSpan(): boolean {
    const { s } = this;
    const start = this.pos;
    let at = start;
    while (s.charCodeAt(at) === BACKTICK) at++;
    const run = at - start;
    let search = at;
    while (true) {
      const open = s.indexOf("`", search);
      if (open < 0) {
        // No closer: the whole run is text.
        this.pos = at;
        this.appendText(s.slice(start, at), this.src(start), this.srcEnd(at));
        return true;
      }
      let close = open;
      while (s.charCodeAt(close) === BACKTICK) close++;
      if (close - open === run) {
        const value = stripPadding(s.slice(at, open));
        this.pos = close;
        this.appendNode(
          { type: "inlineCode", value } as PhrasingContent,
          this.src(start),
          this.srcEnd(close),
        );
        return true;
      }
      search = close;
    }
  }

  parseMath(): boolean {
    const match = scanDollarMath(this.s, this.pos, this.options.mathSingleLine === true);
    return match !== null && this.appendMath(match);
  }

  parseTexMath(): boolean {
    const match = scanTexMath(this.s, this.pos, this.options.mathSingleLine === true);
    return match !== null && this.appendMath(match);
  }

  appendMath(match: InlineMathMatch): boolean {
    const start = this.pos;
    const value = stripPadding(this.s.slice(match.contentStart, match.contentEnd));
    // patches/mdast-util-math@3.0.0.patch: `$$` and `\[` display even inline.
    const display = this.s.startsWith("$$", start) || this.s.startsWith("\\[", start);
    this.pos = match.end;
    this.appendNode(
      {
        type: "inlineMath",
        value,
        data: {
          hName: "code",
          hProperties: { className: ["language-math", display ? "math-display" : "math-inline"] },
          hChildren: [{ type: "text", value }],
        },
      } as unknown as PhrasingContent,
      this.src(start),
      this.srcEnd(match.end),
    );
    return true;
  }

  parseDelimiterRun(char: number): boolean {
    const { s } = this;
    const start = this.pos;
    let at = start;
    while (s.charCodeAt(at) === char) at++;
    const count = at - start;
    if (char === TILDE && count > 2) {
      this.pos = at;
      this.appendText(s.slice(start, at), this.src(start), this.srcEnd(at));
      return true;
    }
    const before = classifyBefore(s, start);
    const after = classify(s, at);
    let canOpen: boolean;
    let canClose: boolean;
    if (char === TILDE) {
      canOpen = after !== 1 && !(after === 2 && before === 0);
      canClose = before !== 1 && !(before === 2 && after === 0);
      canOpen = after !== 1;
      canClose = before !== 1;
      // micromark-extension-gfm-strikethrough: open = !after-whitespace-or-punct-unless...
      canOpen = !after || (after === 2 && !!before);
      canClose = !before || (before === 2 && !!after);
    } else {
      const leftFlanking = after !== 1 && (after !== 2 || before !== 0);
      const rightFlanking = before !== 1 && (before !== 2 || after !== 0);
      if (char === UNDERSCORE) {
        canOpen = leftFlanking && (!rightFlanking || before === 2);
        canClose = rightFlanking && (!leftFlanking || after === 2);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
    }
    this.pos = at;
    const node = this.append({
      kind: "delim",
      start: this.src(start),
      end: this.srcEnd(at),
      value: s.slice(start, at),
      char,
      count,
      origCount: count,
      canOpen,
      canClose,
      prev: null,
      next: null,
    });
    if (canOpen || canClose) {
      this.delimiters = { node, prev: this.delimiters, next: null };
      if (this.delimiters.prev) this.delimiters.prev.next = this.delimiters;
    } else {
      node.kind = "text";
    }
    return true;
  }

  removeDelimiter(delimiter: Delimiter) {
    if (delimiter.prev) delimiter.prev.next = delimiter.next;
    if (delimiter.next) delimiter.next.prev = delimiter.prev;
    else this.delimiters = delimiter.prev;
  }

  processEmphasis(bottom: Delimiter | null) {
    const openersBottom = new Map<string, Delimiter | null>();
    let closer = this.delimiters;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      const cn = closer.node;
      if (!cn.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${cn.char}:${cn.canOpen ? 1 : 0}:${cn.origCount! % 3}:${cn.char === TILDE ? cn.count : 0}`;
      let opener = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== openersBottom.get(key)) {
        const on = opener.node;
        if (on.char === cn.char && on.canOpen) {
          if (cn.char === TILDE) {
            if (on.count === cn.count) {
              found = true;
              break;
            }
          } else {
            const odd =
              (cn.canOpen || on.canClose) &&
              (on.origCount! + cn.origCount!) % 3 === 0 &&
              (on.origCount! % 3 !== 0 || cn.origCount! % 3 !== 0);
            if (!odd) {
              found = true;
              break;
            }
          }
        }
        opener = opener.prev;
      }
      const oldCloser = closer;
      if (found && opener) {
        const on = opener.node;
        const used = cn.char === TILDE ? cn.count! : on.count! >= 2 && cn.count! >= 2 ? 2 : 1;
        on.count! -= used;
        cn.count! -= used;
        // Shrink the delimiter runs: opener keeps its left part, closer its right part.
        const openerEnd = on.end - used;
        const closerStart = cn.start + used;
        const type = cn.char === TILDE ? "delete" : used === 2 ? "strong" : "emphasis";
        const children = this.finish(on.next, cn);
        const node = { type, children } as PhrasingContent;
        const inner: InlineNode = {
          kind: "node",
          start: openerEnd,
          end: closerStart,
          node,
          prev: null,
          next: null,
        };
        // Splice the new node between opener and closer.
        on.next = inner;
        inner.prev = on;
        inner.next = cn;
        cn.prev = inner;
        on.end = openerEnd;
        on.value = on.value!.slice(0, on.count);
        cn.start = closerStart;
        cn.value = cn.value!.slice(0, cn.count);
        // Delimiters between opener and closer are gone.
        let d = closer.prev;
        while (d && d !== opener) {
          const prev = d.prev;
          this.removeDelimiter(d);
          d = prev;
        }
        if (on.count === 0) {
          this.remove(on);
          this.removeDelimiter(opener);
        }
        if (cn.count === 0) {
          this.remove(cn);
          const next = closer.next;
          this.removeDelimiter(closer);
          closer = next;
        }
      } else {
        openersBottom.set(key, oldCloser.prev);
        if (!cn.canOpen) {
          const next = closer.next;
          cn.kind = "text";
          this.removeDelimiter(closer);
          closer = next;
        } else {
          closer = closer.next;
        }
      }
    }
    while (this.delimiters && this.delimiters !== bottom) {
      this.delimiters.node.kind = "text";
      this.removeDelimiter(this.delimiters);
    }
  }

  /** mdast children for the nodes from `from` up to (not including) `until`. */
  finish(from: InlineNode | null, until: InlineNode | null): PhrasingContent[] {
    const out: PhrasingContent[] = [];
    let text: { value: string; start: number; end: number } | null = null;
    const flush = () => {
      if (text && text.value !== "") {
        out.push({
          type: "text",
          value: text.value,
          position: this.position(text.start, text.end),
        } as PhrasingContent);
      }
      text = null;
    };
    for (let n = from; n && n !== until; n = n.next) {
      if (n.kind === "node") {
        flush();
        n.node!.position = this.position(n.start, n.end);
        out.push(n.node!);
        continue;
      }
      const value = n.value ?? "";
      if (n.kind === "bracket" || n.kind === "delim" || n.kind === "text") {
        if (text) {
          (text as { value: string }).value += value;
          (text as { end: number }).end = n.end;
        } else {
          flush();
          text = { value, start: n.start, end: n.end };
        }
      }
    }
    flush();
    return out;
  }

  parseOpenBracket(image: boolean): boolean {
    const { s } = this;
    const start = this.pos;
    if (!image && s.charCodeAt(start + 1) === CARET && this.parseFootnoteCall()) return true;
    const length = image ? 2 : 1;
    this.pos = start + length;
    const node = this.append({
      kind: "bracket",
      start: this.src(start),
      end: this.srcEnd(start + length),
      value: s.slice(start, start + length),
      image,
      prev: null,
      next: null,
    });
    this.brackets = {
      node,
      prev: this.brackets,
      prevDelimiter: this.delimiters,
      image,
      active: true,
      index: start + length,
      bracketAfter: false,
    };
    if (this.brackets.prev) this.brackets.prev.bracketAfter = true;
    return true;
  }

  parseFootnoteCall(): boolean {
    const { s } = this;
    const start = this.pos;
    let at = start + 2;
    while (at < s.length) {
      const c = s.charCodeAt(at);
      if (c === RBRACKET) break;
      if (c === LBRACKET || isWhitespaceCode(c) || c === SPACE) return false;
      if (c === BACKSLASH && isAsciiPunctuation(s.charCodeAt(at + 1))) at++;
      at++;
    }
    if (at >= s.length || at === start + 2 || at - start > 1001) return false;
    const label = s.slice(start + 2, at);
    const identifier = normalizeIdentifier(label);
    if (!this.definitions.footnotes.has(identifier)) return false;
    this.pos = at + 1;
    this.appendNode(
      { type: "footnoteReference", identifier: identifier.toLowerCase(), label } as PhrasingContent,
      this.src(start),
      this.srcEnd(at + 1),
    );
    return true;
  }

  parseCloseBracket(): boolean {
    const { s } = this;
    const start = this.pos;
    const opener = this.brackets;
    if (!opener) return false;
    if (!opener.active) {
      this.brackets = opener.prev;
      return false;
    }
    let after = start + 1;
    let url: string | null = null;
    let title: string | null = null;
    let reference: {
      identifier: string;
      label: string;
      type: "full" | "collapsed" | "shortcut";
    } | null = null;
    // Inline link.
    if (s.charCodeAt(after) === LPAREN) {
      const parsed = this.parseInlineDestination(after + 1);
      if (parsed) {
        url = parsed.url;
        title = parsed.title;
        after = parsed.end;
      }
    }
    if (url === null) {
      // Reference: full, collapsed, or shortcut.
      const labelEnd = s.charCodeAt(after) === LBRACKET ? this.scanLinkLabel(after) : -1;
      const ownLabel = s.slice(opener.index, start);
      if (labelEnd > after + 2) {
        const label = s.slice(after + 1, labelEnd - 1);
        const identifier = normalizeIdentifier(label);
        if (this.definitions.links.has(identifier)) {
          reference = { identifier, label: unescapeString(label), type: "full" };
          after = labelEnd;
        }
      } else if (labelEnd === after + 2 || !opener.bracketAfter) {
        const identifier = normalizeIdentifier(ownLabel);
        if (
          ownLabel.length <= 999 &&
          this.definitions.links.has(identifier) &&
          !/^\^/.test(ownLabel)
        ) {
          reference = {
            identifier,
            label: unescapeString(ownLabel),
            type: labelEnd === after + 2 ? "collapsed" : "shortcut",
          };
          if (labelEnd === after + 2) after = labelEnd;
        }
      }
      if (!reference) {
        this.brackets = opener.prev;
        return false;
      }
    }
    // Build the link or image.
    this.pos = start;
    this.processEmphasis(opener.prevDelimiter);
    const children = this.finish(opener.node.next, null);
    const startOffset = opener.node.start;
    const end = this.srcEnd(after);
    let node: PhrasingContent;
    if (reference) {
      const definition = this.definitions.links.get(reference.identifier)!;
      node = opener.image
        ? ({
            type: "imageReference",
            identifier: reference.identifier.toLowerCase(),
            label: reference.label,
            referenceType: reference.type,
            alt: plainText(children),
          } as unknown as PhrasingContent)
        : ({
            type: "linkReference",
            identifier: reference.identifier.toLowerCase(),
            label: reference.label,
            referenceType: reference.type,
            children,
          } as unknown as PhrasingContent);
      void definition;
    } else {
      node = opener.image
        ? ({ type: "image", title, url: url!, alt: plainText(children) } as PhrasingContent)
        : ({ type: "link", title, url: url!, children } as PhrasingContent);
    }
    // Replace the opener and everything after it with the new node.
    const prev = opener.node.prev;
    if (prev) {
      prev.next = null;
      this.tail = prev;
    } else {
      this.head = null;
      this.tail = null;
    }
    this.appendNode(node, startOffset, end);
    this.pos = after;
    this.brackets = opener.prev;
    if (!opener.image) {
      for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false;
    }
    return true;
  }

  /** End (exclusive) of a link label starting at `[`, or -1. */
  scanLinkLabel(at: number): number {
    const { s } = this;
    let i = at + 1;
    let length = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === BACKSLASH && isAsciiPunctuation(s.charCodeAt(i + 1))) {
        i += 2;
        length += 2;
        continue;
      }
      if (c === LBRACKET) return -1;
      if (c === RBRACKET) {
        if (length > 999) return -1;
        const label = s.slice(at + 1, i);
        if (label.trim() === "" && length > 0) return -1;
        return i + 1;
      }
      i++;
      length++;
    }
    return -1;
  }

  parseInlineDestination(at: number): { url: string; title: string | null; end: number } | null {
    const { s } = this;
    let i = skipWhitespace(s, at);
    let url = "";
    let rawStart = i;
    let rawEnd = i;
    if (s.charCodeAt(i) === LT) {
      let j = i + 1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === BACKSLASH && isAsciiPunctuation(s.charCodeAt(j + 1))) {
          j += 2;
          continue;
        }
        if (c === GT || c === LT || c === LF || c === CR) break;
        j++;
      }
      if (s.charCodeAt(j) !== GT) return null;
      rawStart = i + 1;
      rawEnd = j;
      i = j + 1;
    } else {
      let depth = 0;
      let j = i;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === BACKSLASH && isAsciiPunctuation(s.charCodeAt(j + 1))) {
          j += 2;
          continue;
        }
        if (c < 33 || c === 127) break;
        if (c === LPAREN) {
          depth++;
          if (depth > 32) return null;
        } else if (c === RPAREN) {
          if (depth === 0) break;
          depth--;
        }
        j++;
      }
      if (depth !== 0) return null;
      rawStart = i;
      rawEnd = j;
      i = j;
    }
    const authored = s.slice(rawStart, rawEnd);
    url =
      isWindowsAbsolutePath(authored) && !authored.includes("&")
        ? authored
        : unescapeString(authored);
    const afterDest = i;
    i = skipWhitespace(s, i);
    let title: string | null = null;
    const q = s.charCodeAt(i);
    if ((q === QUOTE || q === APOS || q === LPAREN) && i > afterDest) {
      const close = q === LPAREN ? RPAREN : q;
      let j = i + 1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === BACKSLASH && isAsciiPunctuation(s.charCodeAt(j + 1))) {
          j += 2;
          continue;
        }
        if (c === close) break;
        if (q === LPAREN && c === LPAREN) return null;
        j++;
      }
      if (j >= s.length) return null;
      title = unescapeString(s.slice(i + 1, j));
      i = skipWhitespace(s, j + 1);
    }
    if (s.charCodeAt(i) !== RPAREN) return null;
    return { url, title, end: i + 1 };
  }

  parseAutolink(): boolean {
    const { s } = this;
    const start = this.pos;
    let i = start + 1;
    // URI autolink: scheme of 2-32 characters, then non-space, non-<> characters.
    let j = i;
    while (j < s.length && /[A-Za-z0-9+.-]/.test(s[j]!)) j++;
    if (j - i >= 2 && j - i <= 32 && /[A-Za-z]/.test(s[i]!) && s.charCodeAt(j) === COLON) {
      let k = j + 1;
      while (k < s.length) {
        const c = s.charCodeAt(k);
        if (c === GT || c === LT || c <= SPACE) break;
        k++;
      }
      if (s.charCodeAt(k) === GT) {
        const url = s.slice(i, k);
        this.pos = k + 1;
        this.appendNode(
          {
            type: "link",
            title: null,
            url,
            children: [
              { type: "text", value: url, position: this.position(this.src(i), this.srcEnd(k)) },
            ],
          } as PhrasingContent,
          this.src(start),
          this.srcEnd(k + 1),
        );
        return true;
      }
    }
    // Email autolink.
    const email =
      /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.exec(
        s.slice(i, i + 400),
      );
    if (email) {
      const value = email[0].slice(0, -1);
      const k = i + value.length;
      this.pos = k + 1;
      this.appendNode(
        {
          type: "link",
          title: null,
          url: `mailto:${value}`,
          children: [{ type: "text", value, position: this.position(this.src(i), this.srcEnd(k)) }],
        } as PhrasingContent,
        this.src(start),
        this.srcEnd(k + 1),
      );
      return true;
    }
    return false;
  }

  parseInlineHtml(): boolean {
    const { s } = this;
    const start = this.pos;
    let end = -1;
    if (s.startsWith("<!--", start)) {
      if (s.startsWith("<!-->", start)) end = start + 5;
      else if (s.startsWith("<!--->", start)) end = start + 6;
      else {
        const close = s.indexOf("-->", start + 4);
        end = close < 0 ? -1 : close + 3;
      }
    } else if (s.startsWith("<?", start)) {
      const close = s.indexOf("?>", start + 2);
      end = close < 0 ? -1 : close + 2;
    } else if (s.startsWith("<![CDATA[", start)) {
      const close = s.indexOf("]]>", start + 9);
      end = close < 0 ? -1 : close + 3;
    } else if (s.charCodeAt(start + 1) === BANG && /[A-Za-z]/.test(s[start + 2] ?? "")) {
      const close = s.indexOf(">", start + 2);
      end = close < 0 ? -1 : close + 1;
    } else {
      end = scanHtmlTag(s, start, s.length, false);
    }
    if (end < 0) return false;
    this.pos = end;
    this.appendNode(
      { type: "html", value: s.slice(start, end) } as PhrasingContent,
      this.src(start),
      this.srcEnd(end),
    );
    return true;
  }

  parseEntity(): boolean {
    const { s } = this;
    const start = this.pos;
    const match = matchEntity(s, start);
    if (!match) return false;
    this.pos = match.end;
    this.appendText(match.value, this.src(start), this.srcEnd(match.end));
    return true;
  }

  parseTextDirective(): boolean {
    const { s } = this;
    const start = this.pos;
    if (s.charCodeAt(start + 1) === COLON) return false;
    if (start > 0 && s.charCodeAt(start - 1) === COLON) return false;
    let name = "";
    for (const candidate of TEXT_DIRECTIVE_NAMES) {
      if (s.startsWith(candidate, start + 1)) {
        const after = s.charCodeAt(start + 1 + candidate.length);
        if (
          !(after === 45 || after === UNDERSCORE || /[A-Za-z0-9]/.test(String.fromCharCode(after)))
        ) {
          name = candidate;
          break;
        }
      }
    }
    if (!name) return false;
    let at = start + 1 + name.length;
    let labelStart = -1;
    let labelEnd = -1;
    if (s.charCodeAt(at) === LBRACKET) {
      const close = scanBalanced(s, at, LBRACKET, RBRACKET);
      if (close < 0) return false;
      labelStart = at + 1;
      labelEnd = close;
      at = close + 1;
    }
    let attributes: Record<string, string> = {};
    if (s.charCodeAt(at) === LBRACE) {
      const parsed = parseDirectiveAttributes(s, at);
      if (!parsed) return false;
      attributes = parsed.attributes;
      at = parsed.end;
    }
    let children: PhrasingContent[] = [];
    if (labelStart >= 0) {
      const sub = new InlineParser(
        this.source,
        {
          text: s.slice(labelStart, labelEnd),
          contentStarts: [0],
          sourceStarts: [this.src(labelStart)],
        },
        this.definitions,
        this.options,
        this.points,
      );
      children = sub.parse();
    }
    this.pos = at;
    this.appendNode(
      { type: "textDirective", name, attributes, children } as unknown as PhrasingContent,
      this.src(start),
      this.srcEnd(at),
    );
    return true;
  }
}

/** One space or line ending is stripped from each side of code and math with both. */
function stripPadding(value: string): string {
  if (value.length < 2 || /^[ \r\n]*$/.test(value)) return value;
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  const pad = (c: number) => c === SPACE || c === LF || c === CR;
  if (!pad(first) || !pad(last)) return value;
  const start = value.startsWith("\r\n") ? 2 : 1;
  const end = value.endsWith("\r\n") ? value.length - 2 : value.length - 1;
  return start >= end ? "" : value.slice(start, end);
}

// 1 always starts a construct, 2 with math, 3 with directives.
const SPECIAL = new Uint8Array(128);
for (const c of [
  LF,
  CR,
  BACKSLASH,
  BACKTICK,
  STAR,
  UNDERSCORE,
  TILDE,
  LBRACKET,
  RBRACKET,
  BANG,
  LT,
  AMP,
])
  SPECIAL[c] = 1;
SPECIAL[DOLLAR] = 2;
SPECIAL[COLON] = 3;

const TEXT_DIRECTIVE_NAMES = ["codex-file-citation", "codex-followup"];

/** End (exclusive, at the closer) of a balanced run starting at `open`, or -1. */
function scanBalanced(s: string, at: number, open: number, close: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH) {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseDirectiveAttributes(
  s: string,
  at: number,
): { attributes: Record<string, string>; end: number } | null {
  const attributes: Record<string, string> = {};
  let i = at + 1;
  const classes: string[] = [];
  while (i < s.length) {
    while (i < s.length && isWhitespaceCode(s.charCodeAt(i))) i++;
    const c = s.charCodeAt(i);
    if (c === RBRACE) {
      if (classes.length > 0) attributes.class = classes.join(" ");
      return { attributes, end: i + 1 };
    }
    if (c === HASH || c === 46) {
      let j = i + 1;
      while (j < s.length && /[^\s"'<=>`{}#.]/.test(s[j]!)) j++;
      if (j === i + 1) return null;
      const value = s.slice(i + 1, j);
      if (c === HASH) attributes.id = value;
      else classes.push(value);
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && /[A-Za-z0-9_:.-]/.test(s[j]!)) j++;
    if (j === i) return null;
    const name = s.slice(i, j);
    i = j;
    while (i < s.length && isWhitespaceCode(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== 61) {
      attributes[name] = "";
      continue;
    }
    i++;
    while (i < s.length && isWhitespaceCode(s.charCodeAt(i))) i++;
    const q = s.charCodeAt(i);
    if (q === QUOTE || q === APOS) {
      const close = s.indexOf(String.fromCharCode(q), i + 1);
      if (close < 0) return null;
      attributes[name] = decodeEntities(s.slice(i + 1, close));
      i = close + 1;
    } else {
      let k = i;
      while (k < s.length && /[^\s"'<=>`{}]/.test(s[k]!)) k++;
      if (k === i) return null;
      attributes[name] = decodeEntities(s.slice(i, k));
      i = k;
    }
  }
  return null;
}

function skipWhitespace(s: string, at: number): number {
  let i = at;
  while (i < s.length && isWhitespaceCode(s.charCodeAt(i))) i++;
  return i;
}

function plainText(children: ReadonlyArray<PhrasingContent>): string {
  let out = "";
  for (const child of children) {
    if ("value" in child && typeof child.value === "string") out += child.value;
    else if ("alt" in child && typeof child.alt === "string") out += child.alt;
    else if ("children" in child) out += plainText(child.children as PhrasingContent[]);
  }
  return out;
}

function matchEntity(s: string, at: number): { value: string; end: number } | null {
  if (s.charCodeAt(at) !== AMP) return null;
  if (s.charCodeAt(at + 1) === HASH) {
    const hex = (s.charCodeAt(at + 2) | 32) === 120;
    let i = at + (hex ? 3 : 2);
    const digitsStart = i;
    while (i < s.length && (hex ? /[0-9a-fA-F]/ : /[0-9]/).test(s[i]!)) i++;
    const digits = i - digitsStart;
    if (digits === 0 || digits > (hex ? 6 : 7) || s.charCodeAt(i) !== SEMI) return null;
    let code = Number.parseInt(s.slice(digitsStart, i), hex ? 16 : 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    // micromark decodes C1 controls and other non-characters as replacement characters too.
    return { value: String.fromCodePoint(code), end: i + 1 };
  }
  let i = at + 1;
  while (i < s.length && i - at <= 32 && /[A-Za-z0-9]/.test(s[i]!)) i++;
  if (i === at + 1 || s.charCodeAt(i) !== SEMI) return null;
  const value = decodeEntity(s.slice(at + 1, i));
  return value === null ? null : { value, end: i + 1 };
}

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const amp = value.indexOf("&", i);
    if (amp < 0) break;
    const match = matchEntity(value, amp);
    if (match) {
      out += value.slice(i, amp) + match.value;
      i = match.end;
    } else {
      out += value.slice(i, amp + 1);
      i = amp + 1;
    }
  }
  return out + value.slice(i);
}

/** Backslash escapes and character references, as in destinations, titles and info strings. */
export function unescapeString(value: string): string {
  if (!value.includes("\\") && !value.includes("&")) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === BACKSLASH && isAsciiPunctuation(value.charCodeAt(i + 1))) {
      out += value[i + 1];
      i++;
      continue;
    }
    if (c === AMP) {
      const match = matchEntity(value, i);
      if (match) {
        out += match.value;
        i = match.end - 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

// A drive path that has not reached whitespace yet: `C:`, `C:\Users\me`, `C:/work`.
const UNFINISHED_DRIVE_PATH = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/;

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value) || value.startsWith("\\\\");
}
