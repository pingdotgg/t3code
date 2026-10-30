// Raw HTML in Markdown without an HTML parser: the tag subset agents and review bots write
// (details, summary, sup, div, a, img, br, comments) nests across the Markdown tree as parse5
// nests it. Anything that would need parse5's harder rules (tables, misnested formatting,
// raw text elements, foreign content) returns null, and the caller runs rehype-raw.
import type { Element, ElementContent, Properties, Root, Text } from "hast";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import { h } from "hastscript";

type Position = NonNullable<Root["position"]>;
type Point = Position["start"];

class Bail extends Error {}

const VOID = new Set("area base br col embed hr img input keygen link meta param source track wbr".split(" "));
const FORMATTING = new Set("a b big code em font i nobr s small strike strong tt u".split(" "));
// Start tags that close an open `p` (parse5's "in body" rules).
const CLOSES_P = new Set(
  (
    "address article aside blockquote center details dialog dir div dl fieldset figcaption figure " +
    "footer header hgroup main menu nav ol p search section summary ul h1 h2 h3 h4 h5 h6 pre listing " +
    "form hr table xmp plaintext"
  ).split(" "),
);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// Tags whose parse5 handling this subset does not reproduce.
const UNSUPPORTED = new Set(
  (
    "html head body frameset frame template script style textarea title xmp iframe noembed " +
    "noframes noscript plaintext select option optgroup table caption colgroup col tbody thead " +
    "tfoot tr td th li dd dt button form input image isindex keygen math svg applet marquee object " +
    "listing pre nobr ruby rb rp rt rtc menuitem base basefont bgsound link meta param embed area " +
    "math"
  ).split(" "),
);

interface StartToken {
  kind: "start";
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  start: number;
  end: number;
}
type Token =
  | { kind: "text"; value: string; start: number; end: number }
  | StartToken
  | { kind: "end"; name: string; start: number; end: number }
  | { kind: "comment"; start: number; end: number };

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");

/** Tokenizes one raw node as parse5's tokenizer would in the data state. */
function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      tokens.push({ kind: "text", value: decodeHTML(normalizeNewlines(value.slice(textStart, end))), start: textStart, end });
    }
  };
  while (i < value.length) {
    const lt = value.indexOf("<", i);
    if (lt < 0) break;
    const next = value.charCodeAt(lt + 1);
    let end = -1;
    let token: Token | null = null;
    if (value.startsWith("<!--", lt)) {
      if (value.startsWith("<!-->", lt)) end = lt + 5;
      else if (value.startsWith("<!--->", lt)) end = lt + 6;
      else {
        const close = value.indexOf("-->", lt + 4);
        if (close < 0) throw new Bail();
        end = close + 3;
      }
      token = { kind: "comment", start: lt, end };
    } else if (next === 33 || next === 63) {
      // `<!...>` and `<?...>` are bogus comments.
      const close = value.indexOf(">", lt + 2);
      if (close < 0) throw new Bail();
      end = close + 1;
      token = { kind: "comment", start: lt, end };
    } else if (next === 47) {
      if (!isAlpha(value.charCodeAt(lt + 2))) throw new Bail();
      let j = lt + 2;
      while (j < value.length && !isSpace(value.charCodeAt(j)) && value[j] !== "/" && value[j] !== ">") j++;
      const close = value.indexOf(">", j);
      if (close < 0) throw new Bail();
      end = close + 1;
      token = { kind: "end", name: value.slice(lt + 2, j).toLowerCase(), start: lt, end };
    } else if (isAlpha(next)) {
      const parsed = startTag(value, lt);
      end = parsed.end;
      token = parsed;
    }
    if (!token) {
      i = lt + 1;
      continue;
    }
    flushText(lt);
    tokens.push(token);
    i = end;
    textStart = end;
  }
  flushText(value.length);
  return tokens;
}

function startTag(value: string, at: number): StartToken {
  let j = at + 1;
  while (j < value.length && !isSpace(value.charCodeAt(j)) && value[j] !== "/" && value[j] !== ">") j++;
  const name = value.slice(at + 1, j).toLowerCase();
  const attributes: Record<string, string> = {};
  let selfClosing = false;
  while (true) {
    while (j < value.length && (isSpace(value.charCodeAt(j)) || value[j] === "/")) {
      if (value[j] === "/" && value[j + 1] === ">") {
        selfClosing = true;
        j++;
        break;
      }
      j++;
    }
    if (j >= value.length) throw new Bail();
    if (value[j] === ">") return { kind: "start", name, attributes, selfClosing, start: at, end: j + 1 };
    // Attribute name; a leading `=` belongs to it.
    let k = j + 1;
    while (k < value.length && !isSpace(value.charCodeAt(k)) && value[k] !== "/" && value[k] !== ">" && value[k] !== "=") k++;
    const attributeName = value.slice(j, k).toLowerCase();
    j = k;
    while (j < value.length && isSpace(value.charCodeAt(j))) j++;
    let attributeValue = "";
    if (value[j] === "=") {
      j++;
      while (j < value.length && isSpace(value.charCodeAt(j))) j++;
      const quote = value[j];
      if (quote === '"' || quote === "'") {
        const close = value.indexOf(quote, j + 1);
        if (close < 0) throw new Bail();
        attributeValue = value.slice(j + 1, close);
        j = close + 1;
      } else {
        let u = j;
        while (u < value.length && !isSpace(value.charCodeAt(u)) && value[u] !== ">") u++;
        attributeValue = value.slice(j, u);
        j = u;
      }
    }
    if (!(attributeName in attributes)) {
      attributes[attributeName] = decodeHTMLAttribute(normalizeNewlines(attributeValue));
    }
  }
}

interface RawNode {
  type: "raw";
  value: string;
  position?: Position;
}

/** parse5 counts lines and columns through the raw value from the node's start. */
function pointIn(value: string, base: Point | undefined, index: number): Point | undefined {
  if (!base || base.offset === undefined) return undefined;
  let line = base.line;
  let lineStart = -1;
  for (let k = 0; k < index; k++) {
    const c = value.charCodeAt(k);
    if (c === 10 || (c === 13 && value.charCodeAt(k + 1) !== 10)) {
      line++;
      lineStart = k;
    }
  }
  const column = lineStart < 0 ? base.column + index : index - lineStart;
  return { line, column, offset: base.offset + index };
}

const fromRaw = new WeakSet<Element>();
const COMMENT: unique symbol = Symbol("comment");
type Placeholder = { type: typeof COMMENT };
type Child = ElementContent | Placeholder;

interface Scope {
  readonly output: Element | Root;
  /** Where parse5 ends raw elements this scope closes implicitly. */
  readonly implicitEnd: Point | undefined;
  /** End of the last located token in this scope. */
  lastEnd: Point | undefined;
  /** Raw elements opened in this scope, innermost last. */
  readonly open: Element[];
  /** Markdown ancestors the HTML may not close: `p`, headings, links. */
  readonly inParagraph: boolean;
  readonly inLink: boolean;
}

const current = (scope: Scope): Element | Root => scope.open.at(-1) ?? scope.output;

function appendText(parent: Element | Root, value: string, start?: Point, end?: Point) {
  const children = parent.children as Child[];
  const last = children.at(-1);
  if (last && "type" in last && last.type === "text") {
    last.value += value;
    // parse5 extends a located text node with each located run appended to it.
    if (last.position && start && end) last.position = { start: last.position.start, end };
    return;
  }
  const text: Text = { type: "text", value };
  if (start && end) text.position = { start, end };
  children.push(text);
}

const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

/** Text directly in a table's structure, outside cells, removed from it in document order. */
function tableText(node: Element): Text[] {
  const found: Text[] = [];
  const visit = (element: Element) => {
    const kept: ElementContent[] = [];
    for (const child of element.children) {
      if (child.type === "text") found.push(child);
      else {
        if (child.type === "element" && TABLE_PARTS.has(child.tagName)) visit(child);
        kept.push(child);
      }
    }
    element.children = kept;
  };
  visit(node);
  return found;
}

function closeParagraph(scope: Scope) {
  const index = scope.open.findLastIndex((element) => element.tagName === "p");
  if (index < 0) return;
  // Only a `p` that is the current node closes without parse5's implied end tags.
  for (const element of scope.open.slice(index + 1)) {
    if (FORMATTING.has(element.tagName)) throw new Bail();
  }
  scope.open.length = index;
}

function assemble(children: ReadonlyArray<ElementContent | RawNode>, scope: Scope) {
  for (const child of children) {
    if (child.type === "raw") {
      const raw = child as RawNode;
      for (const token of tokenize(raw.value)) applyToken(token, raw, scope);
      continue;
    }
    if (child.type === "text") {
      appendText(current(scope), child.value, child.position?.start, child.position?.end);
      continue;
    }
    if (child.type !== "element") continue;
    // A Markdown element: parse5 sees its start tag, its children, then its end tag.
    if (scope.open.some((element) => FORMATTING.has(element.tagName))) throw new Bail();
    if (CLOSES_P.has(child.tagName)) closeParagraph(scope);
    if (child.tagName === "a" && (scope.inLink || scope.open.some((element) => element.tagName === "a"))) {
      throw new Bail();
    }
    const element: Element = { ...child, children: [] };
    if (child.tagName === "table") {
      // hast-util-raw hands parse5 every text node as non-whitespace, so the table's own text
      // (its line endings) is foster parented in front of it.
      for (const text of tableText(child)) appendText(current(scope), text.value);
    }
    (current(scope).children as Child[]).push(element);
    const inner: Scope = {
      output: element,
      // A Markdown end tag carries its element's whole span; parse5 ends elements it closes at
      // that span's start.
      implicitEnd: child.position?.start,
      lastEnd: undefined,
      open: [],
      inParagraph: scope.inParagraph || child.tagName === "p" || HEADINGS.has(child.tagName),
      inLink: scope.inLink || child.tagName === "a",
    };
    assemble(child.children as Array<ElementContent | RawNode>, inner);
    // Raw elements still open end with the Markdown element, unless parse5 would carry them on.
    if (inner.open.some((open) => FORMATTING.has(open.tagName))) throw new Bail();
    endOpen(inner, inner.implicitEnd);
    if (child.position) scope.lastEnd = child.position.end;
  }
}

function endOpen(scope: Scope, end: Point | undefined) {
  for (const element of scope.open) {
    if (element.position && end) element.position = { start: element.position.start, end };
  }
  scope.open.length = 0;
}

function applyToken(token: Token, raw: RawNode, scope: Scope) {
  const base = raw.position?.start;
  const tokenEnd = pointIn(raw.value, base, token.end);
  if (tokenEnd) scope.lastEnd = tokenEnd;
  switch (token.kind) {
    case "comment":
      (current(scope).children as Child[]).push({ type: COMMENT });
      return;
    case "text":
      // Text from raw HTML gets no location.
      appendText(current(scope), token.value);
      return;
    case "start": {
      const { name } = token;
      if (UNSUPPORTED.has(name) || name.includes(":")) throw new Bail();
      if (CLOSES_P.has(name)) {
        if (scope.inParagraph) throw new Bail();
        closeParagraph(scope);
      }
      if (HEADINGS.has(name) && HEADINGS.has((current(scope) as Element).tagName ?? "")) scope.open.pop();
      if (name === "a" && (scope.inLink || scope.open.some((element) => element.tagName === "a"))) throw new Bail();
      const element = h(name, token.attributes) as Element;
      const start = pointIn(raw.value, base, token.start);
      const end = pointIn(raw.value, base, token.end);
      if (start && end) element.position = { start, end };
      fromRaw.add(element);
      (current(scope).children as Child[]).push(element);
      if (!VOID.has(name)) scope.open.push(element);
      return;
    }
    case "end": {
      const { name } = token;
      if (name === "br" || name === "p") {
        if (name === "br" || !scope.open.some((element) => element.tagName === "p")) throw new Bail();
      }
      const index = scope.open.findLastIndex((element) => element.tagName === name);
      if (index < 0) {
        // An end tag for an element outside this scope would close Markdown elements.
        if (FORMATTING.has(name)) throw new Bail();
        return;
      }
      for (const element of scope.open.slice(index + 1)) {
        if (FORMATTING.has(element.tagName)) throw new Bail();
      }
      if (FORMATTING.has(name) && index !== scope.open.length - 1) throw new Bail();
      const element = scope.open[index]!;
      const end = pointIn(raw.value, base, token.end);
      if (element.position && end) element.position = { start: element.position.start, end };
      scope.open.length = index;
      return;
    }
  }
}

function dropComments(parent: Element | Root) {
  const children = parent.children as Child[];
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (!("type" in child) || child.type === COMMENT) children.splice(index, 1);
    else if (child.type === "element") dropComments(child);
  }
}

export interface RawHtmlHooks {
  /** What runs between the HTML parser and sanitizing: image metadata, standalone images. */
  readonly beforeSanitize: (tree: Root) => void;
  /** Sanitizes one tree with the chat's schema. */
  readonly sanitize: (tree: Root) => Root;
}

/** Sanitizes elements the raw HTML made; Markdown elements were sanitized as they were built. */
function sanitizeRaw(parent: Element | Root, hooks: RawHtmlHooks) {
  const out: ElementContent[] = [];
  for (const child of parent.children as ElementContent[]) {
    if (child.type !== "element") {
      out.push(child);
      continue;
    }
    sanitizeRaw(child, hooks);
    if (!fromRaw.has(child)) {
      out.push(child);
      continue;
    }
    const shallow: Element = { ...child, children: [] };
    const result = hooks.sanitize({ type: "root", children: [shallow] });
    const safe = result.children[0];
    if (safe?.type === "element") {
      safe.children = child.children;
      out.push(safe);
    } else {
      // Unknown elements give way to their children.
      out.push(...child.children);
    }
  }
  parent.children = out as typeof parent.children;
}

/**
 * Nests raw HTML nodes in `tree` as rehype-raw would, then sanitizes what they made. Returns
 * null when the HTML needs parse5.
 */
export function assembleRawHtml(tree: Root, hooks: RawHtmlHooks): Root | null {
  const root: Root = { ...tree, children: [] };
  try {
    const scope: Scope = {
      output: root,
      implicitEnd: undefined,
      lastEnd: undefined,
      open: [],
      inParagraph: false,
      inLink: false,
    };
    assemble(tree.children as Array<ElementContent | RawNode>, scope);
    endOpen(scope, scope.lastEnd);
  } catch (error) {
    if (error instanceof Bail) return null;
    throw error;
  }
  dropComments(root);
  root.data = { quirksMode: false };
  hooks.beforeSanitize(root);
  sanitizeRaw(root, hooks);
  return root;
}

export type { Properties };
