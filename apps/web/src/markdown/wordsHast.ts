import type { Element, ElementContent, Root, Text } from "hast";
import {
  init as initWords,
  renderToHtml as wordsRenderToHtml,
  type RenderOptions as WordsRenderOptions,
} from "@pierre/words/core";
import wordsWasm from "@pierre/words/wasm";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import { find, html as htmlSchema, svg as svgSchema } from "property-information";
import { resolveCodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { resolveCodexFileCitationLink } from "@t3tools/shared/codexFileCitations";
import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import { expandGithubEmojiAliases } from "@t3tools/client-runtime/pull-request-markdown";
import { resolveChangeRequestMediaUrl } from "@t3tools/client-runtime/pull-request-references";
import { expandIndentedCodeTabs } from "@t3tools/shared/markdownListIndentation";
import { GITHUB_ALERT_MARKER } from "@t3tools/shared/markdownGithubAlerts";
import { absoluteFilePathMatches } from "@t3tools/shared/markdownLinks";
import {
  rehypeNormalizeLocalFileLinks,
  rehypePreserveImageSourceMeta,
  sanitizeChatHast,
} from "@t3tools/shared/markdownHast";

import { rehypeChipPunctuation } from "../components/chat/markdownChipPunctuation";
import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { rehypeTextDirection } from "../components/chat/markdownTextDirection";

/** What a kind of message adds to chat Markdown. Pass a stable object: renderers cache by it. */
export interface MarkdownExtensions {
  /**
   * A sent user message: a single `~` stays text, and a written list number that breaks the
   * sequence stays, so the bubble shows what the composer showed.
   */
  readonly userMessage?: boolean;
  /** Spaces typed at the start of a line show, as the composer showed them (keepLeadingWhitespace). */
  readonly leadingWhitespace?: boolean;
  /** A saved file's Markdown, which must not load URLs or act: links, images and HTML are text. */
  readonly inert?: boolean;
  /** The whole message flattened to one line of text and math, or `fallback` when empty. */
  readonly preview?: { readonly fallback: string; readonly maxLength: number };
  /** A change request's body: root-relative media resolve on its host, and references link. */
  readonly changeRequest?: {
    readonly repositoryUrl: string;
    readonly autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null;
  };
  /** Expand GitHub `:alias:` emoji shortcodes in prose outside code. */
  readonly githubEmoji?: boolean;
  /**
   * Chunked Markdown footnote rendering mode:
   * - `"omit"` hides the per-chunk `<section data-footnotes>`.
   * - `"omit-seeded"` also strips the synthetic leading `<p>` used to seed prior footnote numbers.
   * - `"only"` keeps only the `<section data-footnotes>` element.
   */
  readonly footnotes?: "omit" | "omit-seeded" | "only";
}

export interface WordsHastOptions {
  /** `$…$`, `$$…$$` and `math` code blocks render as SVG. */
  readonly math: boolean;
  /** Soft line breaks render as `<br>`, as remark-breaks does. */
  readonly breaks: boolean;
  /** Raw HTML shows as the text it was written as. */
  readonly escapeHtml: boolean;
  /** `★ Insight ───` blocks render as insight callouts. */
  readonly insights: boolean;
  readonly extensions: MarkdownExtensions;
}

const CODEX_DIRECTIVES = ["codex-file-citation", "codex-followup", "artifact-template"];

const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));

const TAG =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--(?:-?>|[\s\S]*?-->)|<![^>]*>|<\?[\s\S]*?\?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Start tags an HTML parser closes an open `<p>` for, and the elements that scope that search.
const CLOSES_PARAGRAPH = new Set(
  "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p plaintext pre search section summary table ul xmp dd dt".split(
    " ",
  ),
);
const PARAGRAPH_SCOPE = new Set([
  "applet",
  "caption",
  "table",
  "td",
  "th",
  "marquee",
  "object",
  "template",
  "button",
]);
// HTML special elements stop implicit </li> closing, except address, div, and p.
const LIST_ITEM_SCOPE = new Set(
  "applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input li link listing main marquee menu meta nav noembed noframes noscript object ol param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp".split(
    " ",
  ),
);

type RenderOptions = Omit<WordsRenderOptions, "frontmatter">;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Browsers can disable WebAssembly (JIT off by policy, CSP); renderToHtml then falls back below.
try {
  initWords(new WebAssembly.Module(wordsWasm));
} catch {}

function renderToHtml(markdown: string, options: RenderOptions): Uint8Array {
  try {
    return wordsRenderToHtml(markdown, options);
  } catch {
    return encoder.encode(
      `<p>${markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\n", "<br>")}</p>`,
    );
  }
}

const decode = (value: string) => (value.includes("&") ? decodeHTML(value) : value);

function properties(source: string | undefined, inSvg: boolean): Element["properties"] {
  const result: Element["properties"] = {};
  if (!source) return result;
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!;
    const info = find(inSvg ? svgSchema : htmlSchema, inSvg ? name : name.toLowerCase());
    const raw = match[2] ?? match[3] ?? match[4];
    if (raw === undefined) {
      result[info.property] = info.boolean || info.overloadedBoolean ? true : "";
      continue;
    }
    // Attribute values decode as attributes: `&copy=` in a query stays as written.
    const value = raw.includes("&") ? decodeHTMLAttribute(raw) : raw;
    result[info.property] =
      info.spaceSeparated || info.commaSeparated
        ? value.split(info.commaSeparated ? "," : /\s+/).filter(Boolean)
        : info.boolean
          ? true
          : value;
  }
  return result;
}

interface Tokenized {
  readonly root: Root;
  /** Elements with a `data-sourcepos`, which raw HTML can write too. */
  readonly positioned: Element[];
}

/**
 * Hast for Words' HTML. Its own markup is well formed; raw HTML closes where its end tags say,
 * and is sanitized afterwards, so a misnested tag can only change structure, never safety.
 */
function tokenize(html: string, offsetOf: (byte: number) => number): Tokenized {
  const root: Root = { type: "root", children: [] };
  const positioned: Element[] = [];
  const stack: Array<Root | Element> = [root];
  let svgDepth = 0;
  let last = 0;
  // rehypePreserveBareAnchorPlaceholders: an `<a>` with no attributes that never closes is text.
  const anchors: Array<{ element: Element; parent: Root | Element; tag: string } | null> = [];
  const text = (end: number) => {
    if (end <= last) return;
    const parent = stack.at(-1)!;
    const value = decode(html.slice(last, end));
    const previous = parent.children.at(-1);
    if (previous?.type === "text") previous.value += value;
    else parent.children.push({ type: "text", value } as Text);
  };
  for (const match of html.matchAll(TAG)) {
    text(match.index);
    last = match.index + match[0].length;
    const tagName = match[2]?.toLowerCase();
    if (!tagName) continue;
    if (match[1]) {
      if (tagName === "a") anchors.pop();
      if (tagName === "p" && openParagraph(stack) < 0) {
        // A stray `</p>` is an empty paragraph to an HTML parser.
        (stack.at(-1)!.children as ElementContent[]).push({
          type: "element",
          tagName: "p",
          properties: {},
          children: [],
        });
        continue;
      }
      const at = stack.findLastIndex((node) => node.type === "element" && node.tagName === tagName);
      if (at > 0) {
        for (let index = at; index < stack.length; index++) {
          if ((stack[index] as Element).tagName === "svg") svgDepth--;
        }
        stack.length = at;
      }
      continue;
    }
    const inSvg = svgDepth > 0 || tagName === "svg";
    if (!inSvg && tagName === "li") {
      for (let index = stack.length - 1; index > 0; index--) {
        const openTag = (stack[index] as Element).tagName;
        if (openTag === "li") {
          stack.length = index;
          break;
        }
        if (LIST_ITEM_SCOPE.has(openTag)) break;
      }
    }
    if (!inSvg && CLOSES_PARAGRAPH.has(tagName)) {
      const paragraph = openParagraph(stack);
      if (paragraph > 0) stack.length = paragraph;
    }
    const element: Element = {
      type: "element",
      tagName: inSvg ? match[2]! : tagName,
      properties: properties(match[3], inSvg),
      children: [],
    };
    const sourcepos = element.properties.dataSourcepos;
    if (typeof sourcepos === "string") {
      delete element.properties.dataSourcepos;
      const [start, end] = sourcepos.split("-").map((byte) => offsetOf(Number(byte)));
      element.position = {
        start: { line: 1, column: start! + 1, offset: start! },
        end: { line: 1, column: end! + 1, offset: end! },
      };
      positioned.push(element);
    }
    const parent = stack.at(-1)!;
    (parent.children as ElementContent[]).push(element);
    if (tagName === "a") {
      anchors.push(match[3]?.trim() ? null : { element, parent, tag: match[0] });
    }
    // The HTML parser ignores `/>` on elements that are not void, such as `<a/>`.
    if (!VOID.has(tagName) && (!match[4] || !inSvg)) {
      stack.push(element);
      if (tagName === "svg") svgDepth++;
    }
  }
  text(html.length);
  for (const anchor of anchors) {
    if (!anchor) continue;
    const siblings = anchor.parent.children as ElementContent[];
    const at = siblings.indexOf(anchor.element);
    if (at >= 0)
      siblings.splice(at, 1, { type: "text", value: anchor.tag }, ...anchor.element.children);
  }
  normalizeRawTables(root);
  // Words ends each block with a newline; hast from remark has none after the last.
  const end = root.children.at(-1);
  if (end?.type === "text") {
    end.value = end.value.replace(/\n$/, "");
    if (end.value.trim() === "") root.children.pop();
  }
  return { root, positioned };
}

const positionKey = (node: Element) =>
  `${node.tagName.toLowerCase()}:${node.position!.start.offset}-${node.position!.end.offset}`;

/**
 * Words' HTML for `markdown` as hast. A position marks what Words generated, so raw HTML that
 * writes its own `data-sourcepos` keeps none: Words' elements are those it also writes with raw
 * HTML escaped, and a range claimed more often than that is trusted for none of its claimants.
 */
function parse(markdown: string, options: RenderOptions): Root {
  const offsetOf = utf16Offsets(markdown);
  const render = (escapeHtml?: true) =>
    tokenize(
      decoder.decode(
        renderToHtml(markdown, {
          ...options,
          ...(escapeHtml ? { escapeHtml } : {}),
          sourcePositions: true,
        }),
      ),
      offsetOf,
    );
  const { root, positioned } = render();
  if (options.escapeHtml || options.skipHtml || !/data-sourcepos/i.test(markdown)) return root;
  const generated = new Map<string, number>();
  for (const node of render(true).positioned) {
    const key = positionKey(node);
    generated.set(key, (generated.get(key) ?? 0) + 1);
  }
  const claimed = new Map<string, number>();
  for (const node of positioned) {
    const key = positionKey(node);
    claimed.set(key, (claimed.get(key) ?? 0) + 1);
  }
  for (const node of positioned) {
    const key = positionKey(node);
    if (claimed.get(key)! > (generated.get(key) ?? 0)) delete node.position;
  }
  return root;
}

/** The stack index of the `<p>` an HTML parser would close, or -1 when none is in scope. */
function openParagraph(stack: ReadonlyArray<Root | Element>): number {
  for (let index = stack.length - 1; index > 0; index--) {
    const tagName = (stack[index] as Element).tagName;
    if (tagName === "p") return index;
    if (PARAGRAPH_SCOPE.has(tagName)) return -1;
  }
  return -1;
}

/** parse5 puts a raw HTML table's rows in a `<tbody>`; Words' own tables start with `<thead>`. */
function normalizeRawTables(node: Root | Element) {
  for (const child of node.children) {
    if (child.type === "element") normalizeRawTables(child);
  }
  if (node.type !== "element" || node.tagName !== "table") return;
  const first = node.children.findIndex((child) => isElement(child, "tr"));
  if (first < 0) return;
  node.children = [
    ...node.children.slice(0, first),
    { type: "element", tagName: "tbody", properties: {}, children: node.children.slice(first) },
  ];
}

// Words leaves these raw in Markdown destinations, where micromark percent-encodes them.
const UNSAFE_URL_CHARACTERS = /[\\[\]`{}|^"<> ]/g;
const normalizeUri = (value: string) =>
  value.replace(UNSAFE_URL_CHARACTERS, (character) => encodeURIComponent(character));

const windowsPath = (url: string) => {
  const path = url.replace(/%5C/gi, "\\");
  return /^[A-Za-z]:[\\/]/.test(path) ? path : undefined;
};

const isElement = (node: unknown, tagName?: string): node is Element =>
  (node as Element | undefined)?.type === "element" &&
  (tagName === undefined || (node as Element).tagName === tagName);

const isElementNode = (node: ElementContent): node is Element => node.type === "element";

const isMarkdownImage = (node: unknown): boolean =>
  (isElement(node, "img") && node.position !== undefined) ||
  (isElement(node, "a") &&
    node.position !== undefined &&
    node.children.length === 1 &&
    isMarkdownImage(node.children[0]));

const BREAK: ElementContent = { type: "element", tagName: "br", properties: {}, children: [] };

// Words' math: these elements and presentation attributes, and no links or handlers.
const MATH_ELEMENTS = new Set(["svg", "g", "text", "tspan", "rect", "path"]);
const MATH_PROPERTIES = new Set([
  "xmlns",
  "width",
  "height",
  "viewBox",
  "fill",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "role",
  "ariaLabel",
  "x",
  "y",
  "dx",
  "dy",
  "d",
  "transform",
  "stroke",
  "strokeWidth",
  "textAnchor",
]);
const MATH_STYLE = /^(?:display|vertical-align|overflow|margin|white-space)$/;

function sanitizeMath(node: Element): Element | null {
  if (!MATH_ELEMENTS.has(node.tagName)) return null;
  const properties: Element["properties"] = {};
  for (const [key, value] of Object.entries(node.properties)) {
    if (MATH_PROPERTIES.has(key)) properties[key] = value;
  }
  if (typeof node.properties.style === "string") {
    const style = node.properties.style
      .split(";")
      .filter((rule) => MATH_STYLE.test(rule.split(":")[0]!.trim()))
      .join(";");
    if (style) properties.style = style;
  }
  const children: ElementContent[] = [];
  for (const child of node.children) {
    if (child.type === "text") children.push(child);
    else if (child.type === "element") {
      const clean = sanitizeMath(child);
      if (clean) children.push(clean);
    }
  }
  return { ...node, properties, children };
}

interface Walk {
  /** Words' hast for more Markdown, rendered with the same options; `indent` as leadingWhitespace's. */
  readonly render: (markdown: string, indent: number) => Root;
  /** Reference definitions for re-rendering `markdown`; its own come first, as the first one wins. */
  readonly definitions: (markdown: string) => string;
  readonly source: string;
  readonly options: WordsHastOptions;
  readonly math: Map<string, Element>;
  /** A per-render id prefix for math placeholders, which authored ids cannot share. */
  readonly mathKey: string;
  /** What insightSource opened each insight block with, when it opened any. */
  readonly insightMarker: RegExp | null;
}

/** UTF-16 offsets for the UTF-8 byte offsets in Words' `data-sourcepos`. */
function utf16Offsets(source: string): (byte: number) => number {
  if (!/[^\x00-\x7f]/.test(source)) return (byte) => byte;
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const code = source.codePointAt(index)!;
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    for (let byte = 0; byte < bytes; byte++) offsets.push(index);
    if (code >= 0x10000) index++;
  }
  offsets.push(source.length);
  return (byte) => offsets[byte] ?? source.length;
}

const sourceOf = (node: Element, source: string) =>
  node.position ? source.slice(node.position.start.offset, node.position.end.offset) : "";

const textOf = (node: ElementContent): string =>
  node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(textOf).join("")
      : "";

/** A directive's attributes, as strings; anything else Words would never write reads as none. */
function directiveAttributes(node: Element): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(node.properties.dataAttributes ?? "{}"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** remarkCodexDirectives: what a directive Words parsed becomes, as the remark plugin builds it. */
function codexDirective(node: Element, walk: Walk, inLink: boolean): ElementContent {
  const name = node.properties.dataDirective;
  const attributes = directiveAttributes(node);
  const asText = (): ElementContent => {
    const value: ElementContent = { type: "text", value: sourceOf(node, walk.source) };
    return node.tagName === "div"
      ? { type: "element", tagName: "p", properties: {}, children: [value] }
      : value;
  };
  if (name === "codex-file-citation") {
    const citation = resolveCodexFileCitationLink(attributes);
    if (!citation || inLink) return asText();
    return {
      type: "element",
      tagName: "a",
      properties: { href: citation.href },
      children: [{ type: "text", value: citation.label }],
      ...(node.position ? { position: node.position } : {}),
    };
  }
  if (name === "codex-followup") {
    if (!attributes.prompt?.trim() || !node.children.map(textOf).join("").trim()) return asText();
    return { type: "element", tagName: "span", properties: {}, children: node.children };
  }
  const template = resolveCodexArtifactTemplate(attributes);
  if (!template) return asText();
  return {
    type: "element",
    tagName: "div",
    properties: {
      dataCodexArtifactTemplate: "true",
      dataArtifactKind: template.artifactKind,
      dataDisplayName: template.displayName,
      ...(template.galleryKind === undefined ? {} : { dataGalleryKind: template.galleryKind }),
      dataSkillDirectory: template.skillDirectory,
      dataSkillName: template.skillName,
    },
    children: [],
  };
}

const INLINE_PREFIX = "t3-markdown-inline-prefix ";

function stripPositions(node: ElementContent) {
  delete node.position;
  if (node.type === "element") node.children.forEach(stripPositions);
}

/**
 * remarkNormalizeListItemIndentation: four spaces after a list marker make indented code, but
 * agents mean wide indentation, so code starting on the marker's line is Markdown again. True
 * when it recovered the item, whose children it then has transformed.
 */
function recoverIndentedCode(
  item: Element,
  list: Root | Element,
  walk: Walk,
  inLink: boolean,
  inCode: boolean,
): boolean {
  const code = item.children.find((child) => child.type === "element");
  const start = code?.position?.start.offset;
  const itemStart = item.position?.start.offset;
  if (!isElement(code, "pre") || start === undefined || itemStart === undefined) return false;
  let value = textOf(code);
  if (!/^[\t ]/.test(value)) return false;
  if (walk.source.slice(itemStart, start).includes("\n") || /[`~]/.test(walk.source[start]!)) {
    return false;
  }
  value = expandIndentedCodeTabs(value, walk.source, itemStart);
  // The trimmed first line sets where the item's content starts.
  const indent = [.../^[\t ]*/.exec(value)![0]].reduce(
    (column, character) => (character === "\t" ? (Math.floor(column / 4) + 1) * 4 : column + 1),
    0,
  );
  // The prefix keeps block syntax at the start, such as `#`, from opening a block.
  const source = `${walk.definitions(value)}${INLINE_PREFIX}${value.trim()}`;
  const recovered = walk.render(source, indent);
  const paragraph = recovered.children.find((child) => child.type === "element");
  const first = isElement(paragraph, "p") ? paragraph.children[0] : undefined;
  if (first?.type !== "text" || !first.value.startsWith(INLINE_PREFIX)) return false;
  first.value = first.value.slice(INLINE_PREFIX.length);
  if (first.value === "") paragraph!.children.shift();
  transform(recovered, { ...walk, source }, inLink, inCode);
  transform(item, walk, inLink, inCode);
  let blocks = recovered.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  ) as ElementContent[];
  // Their positions point into `source`, not the message.
  blocks.forEach(stripPositions);
  let at = item.children.indexOf(code);
  let remove = 1;
  if (!isLooseList(list, walk.source)) {
    // A tight item shows its text bare, as remark-rehype unwraps its paragraphs.
    blocks = blocks.flatMap((block, index) => [
      ...(index > 0 ? [{ type: "text", value: "\n" } as Text] : []),
      ...(isElement(block, "p") ? block.children : [block]),
    ]);
    const isBlank = (node: ElementContent | undefined) =>
      node?.type === "text" && node.value.trim() === "";
    if (at === 1 && isBlank(item.children[0])) [at, remove] = [0, 2];
    if (at + remove === item.children.length - 1 && isBlank(item.children.at(-1))) remove++;
  }
  item.children.splice(at, remove, ...blocks);
  return true;
}

/** remark-rehype's listLoose: a blank line between items, or an item Words wrote as paragraphs. */
function isLooseList(list: Root | Element, source: string): boolean {
  const items = (list.children as ElementContent[]).filter((child): child is Element =>
    isElement(child, "li"),
  );
  return items.some(
    (item, index) =>
      item.children.some((child) => isElement(child, "p")) ||
      (index > 0 &&
        /\n[ \t>]*\n/.test(
          source.slice(
            items[index - 1]!.position?.end.offset ?? 0,
            item.position?.start.offset ?? 0,
          ),
        )),
  );
}

const WRITTEN_NUMBER = /[ \t]*(\d{1,9})[.)]/y;

function keepListNumbers(list: Element, source: string) {
  let expected = Number(list.properties.start ?? 1);
  for (const item of list.children) {
    if (!isElement(item, "li")) continue;
    const offset = item.position?.start.offset;
    WRITTEN_NUMBER.lastIndex = offset ?? 0;
    const digits = offset === undefined ? undefined : WRITTEN_NUMBER.exec(source)?.[1];
    const value = digits === undefined ? expected : Number(digits);
    if (value !== expected) item.properties.value = String(value);
    expected = value + 1;
  }
}

/** What the chat's remark plugins add that Words does not. */
const link = (href: string, label: string, properties: Element["properties"] = {}): Element => ({
  type: "element",
  tagName: "a",
  properties: { href, ...properties },
  children: [{ type: "text", value: label }],
});

/** Links in text: absolute file paths (remarkLinkAbsoluteFilePaths), then a change request's references. */
function linkText(value: string, walk: Walk): ElementContent[] | null {
  let parts: ElementContent[] = [];
  let offset = 0;
  for (const { index, path } of absoluteFilePathMatches(value)) {
    if (index > offset) parts.push({ type: "text", value: value.slice(offset, index) });
    parts.push(link(path, path));
    offset = index + path.length;
  }
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  const autolinks = walk.options.extensions.changeRequest?.autolinks;
  if (autolinks) {
    parts = parts.flatMap((part) => {
      if (part.type !== "text") return [part];
      const found = autolinks(part.value);
      if (found.length === 0) return [part];
      const linked: ElementContent[] = [];
      let start = 0;
      for (const reference of found) {
        if (start < reference.index) {
          linked.push({ type: "text", value: part.value.slice(start, reference.index) });
        }
        linked.push(
          link(reference.url, reference.label, { dataPullRequestAutolink: reference.kind }),
        );
        start = reference.index + reference.text.length;
      }
      if (start < part.value.length) linked.push({ type: "text", value: part.value.slice(start) });
      return linked;
    });
  }
  return parts.length === 1 && parts[0]!.type === "text" ? null : parts;
}

function transform(node: Root | Element, walk: Walk, inLink: boolean, inCode: boolean) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "text") {
      if (inCode) continue;
      if (walk.options.extensions.githubEmoji && child.value.includes(":")) {
        child.value = expandGithubEmojiAliases(child.value);
      }
      if (inLink) continue;
      const parts = linkText(child.value, walk);
      if (!parts) continue;
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
      continue;
    }
    if (child.type !== "element") continue;
    // Words gives what it generates a source position; raw HTML that copies its attributes has none.
    if (child.properties.dataDirective !== undefined && child.position) {
      children[index] = codexDirective(child, walk, inLink);
      index--;
      continue;
    }
    const { tagName, properties: props } = child;
    if (tagName === "svg") {
      // Sanitizing drops SVG, so math waits under a placeholder until after it.
      const clean = walk.options.math && child.position ? sanitizeMath(child) : null;
      if (clean) {
        const key = `${walk.mathKey}-${walk.math.size}`;
        walk.math.set(key, clean);
        children[index] = {
          type: "element",
          tagName: "span",
          properties: { id: key },
          children: [],
        };
      }
      continue;
    }
    if (tagName === "a" && props.dataFootnoteRef !== undefined) {
      // remark-rehype's footnote markup, before rehype-sanitize prefixes ids again.
      props.href = `#user-content-${String(props.href).slice(1)}`;
      props.id = `user-content-${String(props.id)}`;
      props.ariaDescribedBy = ["footnote-label"];
    } else if (tagName === "a" && props.dataFootnoteBackref !== undefined) {
      const { href, ariaLabel } = props;
      child.properties = {
        href: `#user-content-${String(href).slice(1)}`,
        dataFootnoteBackref: "",
        ariaLabel,
        className: ["data-footnote-backref"],
      };
    } else if (tagName === "li" && typeof props.id === "string" && props.id.startsWith("fn-")) {
      props.id = `user-content-${props.id}`;
    } else if (tagName === "section" && props.dataFootnotes !== undefined) {
      child.properties = { dataFootnotes: "", className: ["footnotes"] };
      child.children.unshift({
        type: "element",
        tagName: "h2",
        properties: { className: ["sr-only"], id: "footnote-label" },
        children: [{ type: "text", value: "Footnotes" }],
      });
    } else if (tagName === "a" && typeof props.href === "string") {
      // remarkNormalizeLinksAndTagInlineCode: a Windows drive path links as a file URL.
      const path = windowsPath(props.href);
      props.href = path ? `file:///${path.replaceAll("\\", "/")}` : normalizeUri(props.href);
    } else if (tagName === "img" && typeof props.src === "string") {
      const changeRequest = walk.options.extensions.changeRequest;
      const src = changeRequest
        ? resolveChangeRequestMediaUrl(props.src, changeRequest.repositoryUrl)
        : props.src;
      props.src = windowsPath(src) ?? normalizeUri(src);
    } else if (tagName === "code" && isElement(node, "pre")) {
      if (props.dataMeta !== undefined) {
        props.dataCodeMeta = props.dataMeta;
        delete props.dataMeta;
      }
    } else if (tagName === "code" && !inLink) {
      props.dataInlineCode = "";
    } else if (tagName === "ol" && walk.options.extensions.userMessage) {
      keepListNumbers(child, walk.source);
    } else if (tagName === "li") {
      const firstBlock = child.children.find(isElementNode);
      if (isElement(firstBlock, "pre") && recoverIndentedCode(child, node, walk, inLink, inCode)) {
        continue;
      }
      // Tight items put the checkbox directly in `<li>`, loose ones inside its first `<p>`.
      const checkbox = isElement(child.children[0], "input")
        ? child.children[0]
        : isElement(firstBlock, "p") && isElement(firstBlock.children[0], "input")
          ? firstBlock.children[0]
          : undefined;
      if (checkbox) {
        props.className = ["task-list-item"];
        const { checked } = checkbox.properties;
        checkbox.properties = { type: "checkbox", checked, disabled: true };
        if (node.type === "element") node.properties.className = ["contains-task-list"];
      }
      if (child.position) breakLines(child, walk.options.breaks);
    } else if (tagName === "p" && Object.keys(child.properties).length === 0) {
      // Words writes a Markdown paragraph bare; one with attributes is raw HTML, which keeps its
      // lines as written, as remark-breaks never touched raw HTML.
      breakLines(child, walk.options.breaks);
    } else if (tagName === "blockquote") {
      // remarkGithubAlerts
      const paragraph = child.children.find((item) => item.type === "element");
      const first = isElement(paragraph, "p") ? paragraph.children[0] : undefined;
      const text = first?.type === "text" ? first.value : "";
      const insight = walk.insightMarker?.exec(text);
      const alert = GITHUB_ALERT_MARKER.exec(text);
      // An alert marker followed by more inline content on its line is text, as remarkGithubAlerts reads it.
      const match = insight
        ? ([insight[0], "insight"] as const)
        : alert && (alert[0].endsWith("\n") || (paragraph as Element).children.length === 1)
          ? alert
          : null;
      if (match && first?.type === "text" && isElement(paragraph, "p")) {
        first.value = first.value.slice(match[0].length);
        if (first.value === "") paragraph.children.shift();
        if (paragraph.children.length === 0) {
          const at = child.children.indexOf(paragraph);
          const next = child.children[at + 1];
          // The line ending after it goes too, as remark leaves none for a removed paragraph.
          const blank = next?.type === "text" && next.value.trim() === "" ? 2 : 1;
          child.children.splice(at, blank);
        }
        props.dataAlert = match[1]!.toLowerCase();
      }
    }
    transform(
      child,
      walk,
      inLink || tagName === "a",
      inCode || tagName === "code" || tagName === "pre",
    );
  }
}

/**
 * remark-breaks puts a `<br>` before every soft line ending, and remarkBreakAroundImageLines
 * before those next to a Markdown image. Both keep the line ending after it.
 */
/** A Markdown image alone on its line: nothing but a line ending (or the paragraph's edge) around it. */
function imageOwnsLine(items: ElementContent[], at: number): boolean {
  if (!isMarkdownImage(items[at])) return false;
  const before = items[at - 1];
  const after = items[at + 1];
  const startsLine =
    before === undefined ||
    (before.type === "text" && /\n[ \t]*$/.test(before.value)) ||
    isElement(before, "br");
  const endsLine = after === undefined || (after.type === "text" && /^[ \t]*\n/.test(after.value));
  return startsLine && endsLine;
}

const isBlockElement = (node: ElementContent | undefined) =>
  node?.type === "element" && CLOSES_PARAGRAPH.has(node.tagName);

/** Where the images that end a paragraph after its text start: a caption, then its screenshots. */
function trailingImagesStart(items: ElementContent[]): number | undefined {
  let start: number | undefined;
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!;
    if (isMarkdownImage(item)) start = at;
    else if (!isElement(item, "br") && !(item.type === "text" && !item.value.trim())) return start;
  }
  return undefined;
}

function breakLines(paragraph: Element, breaks: boolean) {
  const items = paragraph.children;
  // Inline elements recurse here under `breaks`; only a paragraph's own end is a caption's end.
  const trailing =
    paragraph.tagName === "p" || paragraph.tagName === "li"
      ? trailingImagesStart(items)
      : undefined;
  const trailingImage = trailing === undefined ? undefined : items[trailing];
  const beforeTrailing = trailing === undefined ? undefined : items[trailing - 1];
  // A line ending before the images breaks below; kept indentation already starts a line.
  if (
    trailing !== undefined &&
    beforeTrailing &&
    !(
      beforeTrailing.type === "element" &&
      (beforeTrailing.tagName === "br" ||
        (beforeTrailing.tagName === "span" && "dataLeadingWhitespace" in beforeTrailing.properties))
    ) &&
    !(beforeTrailing.type === "text" && /\n[ \t]*$/.test(beforeTrailing.value))
  ) {
    items.splice(trailing, 0, BREAK, { type: "text", value: "\n" });
    if (beforeTrailing.type === "text") {
      beforeTrailing.value = beforeTrailing.value.replace(/[ \t]+$/, "");
      if (!beforeTrailing.value) items.splice(trailing - 1, 1);
    }
  }
  for (let at = 0; at < items.length; at++) {
    const item = items[at]!;
    if (
      item.type === "element" &&
      breaks &&
      item.tagName !== "code" &&
      !CLOSES_PARAGRAPH.has(item.tagName)
    ) {
      breakLines(item, breaks);
    }
    if (item.type !== "text" || !item.value.includes("\n")) continue;
    const afterImage = imageOwnsLine(items, at - 1);
    const beforeImage =
      imageOwnsLine(items, at + 1) ||
      (trailingImage !== undefined && items[at + 1] === trailingImage);
    const afterBlock = isBlockElement(items[at - 1]) || (at === 0 && paragraph.tagName === "li");
    const beforeBlock =
      isBlockElement(items[at + 1]) || (at === items.length - 1 && paragraph.tagName === "li");
    const lines = item.value.split("\n");
    const parts: ElementContent[] = [];
    lines.forEach((line, index) => {
      // A hard break's own line ending follows its <br>, and adds no second one;
      // structural line endings around a list item's block children stay breaks between blocks.
      const afterHardBreak = index === 1 && isElement(items[at - 1], "br");
      const blockBoundary =
        (index === 1 && lines[0] === "" && afterBlock) ||
        (index === lines.length - 1 && line === "" && beforeBlock);
      const breaksHere =
        index > 0 &&
        !afterHardBreak &&
        !blockBoundary &&
        (breaks || (index === 1 && afterImage) || (index === lines.length - 1 && beforeImage));
      if (index > 0) {
        if (breaksHere) {
          const previous = parts.at(-1);
          if (previous?.type === "text") previous.value = previous.value.replace(/[ \t]+$/, "");
          parts.push(BREAK);
        }
        parts.push({ type: "text", value: `\n${line}` });
      } else if (line) {
        parts.push({ type: "text", value: line });
      }
    });
    // Rejoin text that did not break, so the tree matches remark's text nodes.
    const merged: ElementContent[] = [];
    for (const part of parts) {
      const previous = merged.at(-1);
      if (part.type === "text" && previous?.type === "text") previous.value += part.value;
      else merged.push(part);
    }
    items.splice(at, 1, ...merged);
    at += merged.length - 1;
  }
}

/**
 * The wrapper copying reads (markdown-clipboard's MATH_SELECTOR): the formula's TeX, as the source
 * Words drew it from, so copying any part of a formula copies the whole of it.
 */
// A formula wider than its block scrolls, with room for the glyphs that reach past its box; in a
// table it keeps its width and the table scrolls.
const MATH_SCROLL = [
  "max-w-full",
  "overflow-x-auto",
  "overflow-y-hidden",
  "px-0.5",
  "py-0.75",
  "in-[.chat-markdown-table-container]:max-w-none",
  "in-[.chat-markdown-table-container]:overflow-visible",
];

function mathWrapper(svg: Element): Element {
  const tex = String(svg.properties.ariaLabel ?? "").trim();
  const display = /display:\s*block/.test(String(svg.properties.style ?? ""));
  return {
    type: "element",
    tagName: "span",
    properties: display
      ? {
          className: ["chat-markdown-math-display", "block", ...MATH_SCROLL],
          dataMarkdownMath: "display",
          dataMarkdownCopy: `\\[\n${tex}\n\\]\n\n`,
        }
      : {
          className: ["inline-block", "align-middle", ...MATH_SCROLL],
          dataMarkdownMath: "inline",
          dataMarkdownCopy: `\\(${tex}\\)`,
        },
    children: [svg],
  };
}

function restoreMath(node: Root | Element, math: Map<string, Element>) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "element") continue;
    const id = child.properties.id;
    const svg = typeof id === "string" ? math.get(id.replace(/^user-content-/, "")) : undefined;
    if (svg) children[index] = mathWrapper(svg);
    else restoreMath(child, math);
  }
}

const addHeadingIds = rehypeHeadingIds();
const addTextDirection = rehypeTextDirection();
const preserveImageSourceMeta = rehypePreserveImageSourceMeta();
const normalizeLocalFileLinks = rehypeNormalizeLocalFileLinks();
const groupChipPunctuation = rehypeChipPunctuation();

const INSIGHT_OPENING = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_CLOSING = /^( {0,3})(`?)─{3,}\2[ \t]*$/u;

interface InsightSource {
  readonly source: string;
  readonly tree: Root;
  readonly marker: RegExp;
  /** The offset in the message for an offset in `source`. */
  readonly toOriginal: (offset: number) => number;
}

/**
 * remarkAssistantInsights: a `★ Insight ───` line opens a quoted insight block, which a `───` line
 * at the same indentation closes; the end of the text closes one that never does. Lines in code
 * neither open nor close one, and an opening Words does not read as a quote's first line, as in
 * an HTML block or a quote's lazy line, stays text.
 */
function insightSource(text: string, options: RenderOptions): InsightSource | null {
  if (!text.includes("★ Insight")) return null;
  const code: Array<readonly [number, number]> = [];
  const findCode = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "pre" && child.position) {
        code.push([child.position.start.offset!, child.position.end.offset!]);
      } else findCode(child);
    }
  };
  findCode(parse(text, options));
  const nonce = Math.random().toString(36).slice(2);
  const marker = new RegExp(String.raw`^\[!T3-INSIGHT-${nonce}-(\d+)\](?:\r?\n)?`);
  const anywhere = new RegExp(String.raw`\[!T3-INSIGHT-${nonce}-(\d+)\]`, "g");
  const lines = text.split(/(?<=\n)|(?<=\r)(?!\n)/u);
  const skipped = new Set<number>();
  for (;;) {
    // Each line's offset in the message and in the source, and how much longer it got.
    const offsets: Array<{ original: number; source: number; length: number; delta: number }> = [];
    let original = 0;
    let rewritten = 0;
    let opened = 0;
    let indent: string | undefined;
    const source = lines
      .map((line, lineIndex) => {
        const value = line.replace(/[\r\n]+$/u, "");
        const ending = line.slice(value.length);
        const inCode = code.some(([start, end]) => original >= start && original < end);
        let output = line;
        if (indent === undefined) {
          const opening = inCode ? null : INSIGHT_OPENING.exec(value);
          if (opening && !skipped.has(lineIndex)) {
            indent = opening[1] ?? "";
            opened++;
            output = `> [!T3-INSIGHT-${nonce}-${lineIndex}]${ending}`;
          }
        } else {
          const closing = inCode ? null : INSIGHT_CLOSING.exec(value);
          if (closing && closing[1] === indent) {
            indent = undefined;
            output = ending;
          } else output = `> ${line}`;
        }
        offsets.push({
          original,
          source: rewritten,
          length: line.length,
          delta: output.length - line.length,
        });
        original += line.length;
        rewritten += output.length;
        return output;
      })
      .join("");
    if (opened === 0) return null;
    const tree = parse(source, options);
    let stranded = false;
    const visit = (node: Root | Element, quoteStart: Text | undefined) => {
      for (const child of node.children) {
        if (child.type === "text") {
          for (const found of child.value.matchAll(anywhere)) {
            if (child === quoteStart && found.index === 0) continue;
            skipped.add(Number(found[1]));
            stranded = true;
          }
        } else if (child.type === "element") {
          const paragraph =
            child.tagName === "blockquote" ? child.children.find(isElementNode) : undefined;
          const first = isElement(paragraph, "p") ? paragraph.children[0] : undefined;
          visit(child, first?.type === "text" ? first : quoteStart);
        }
      }
    };
    visit(tree, undefined);
    if (stranded) continue;
    return {
      source,
      tree,
      marker,
      toOriginal: (offset) => {
        let low = 0;
        let high = offsets.length - 1;
        while (low < high) {
          const mid = (low + high + 1) >>> 1;
          if (offsets[mid]!.source <= offset) low = mid;
          else high = mid - 1;
        }
        const line = offsets[low]!;
        return (
          line.original + Math.min(Math.max(offset - line.source - line.delta, 0), line.length)
        );
      },
    };
  }
}

/** Positions that point into an insight's rewritten source, moved back into the message. */
function restorePositions(node: Root | Element, toOriginal: (offset: number) => number) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.position) {
      const start = toOriginal(child.position.start.offset!);
      const end = toOriginal(child.position.end.offset!);
      child.position = {
        start: { line: 1, column: start + 1, offset: start },
        end: { line: 1, column: end + 1, offset: end },
      };
    }
    restorePositions(child, toOriginal);
  }
}

const PREVIEW_SEPARATED = new Set([
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
]);

/** remarkThoughtPreview: the message as one line of text, keeping math, cut at `maxLength`. */
function flattenPreview(tree: Root, preview: NonNullable<MarkdownExtensions["preview"]>): Root {
  const children: ElementContent[] = [];
  let remaining = preview.maxLength;
  let fragments: string[] = [];
  const flush = () => {
    if (fragments.length === 0) return;
    children.push({ type: "text", value: fragments.join("").replace(/\s+/g, " ") });
    fragments = [];
  };
  const take = (value: string) => {
    const text = value.slice(0, remaining);
    remaining = text.length < value.length ? 0 : remaining - text.length;
    // A cut must not leave half a surrogate pair.
    return text.replace(/[\uD800-\uDBFF]$/, "");
  };
  const visit = (node: Root | ElementContent) => {
    if (remaining === 0) return;
    if (node.type === "text") {
      fragments.push(take(node.value));
      return;
    }
    if (
      node.type === "element" &&
      (node.properties.dataFootnotes !== undefined || node.properties.dataFootnoteRef !== undefined)
    ) {
      return;
    }
    if (node.type === "element" && node.properties.dataMarkdownMath !== undefined) {
      flush();
      // One line has no room for display math, which a preview shows inline.
      const svg = node.children[0];
      children.push(
        node.properties.dataMarkdownMath === "display" && svg?.type === "element"
          ? mathWrapper({
              ...svg,
              properties: {
                ...svg.properties,
                style: "display:inline;vertical-align:middle;overflow:visible",
              },
            })
          : node,
      );
      return;
    }
    if (node.type === "element" && node.tagName === "img") {
      fragments.push(take(String(node.properties.alt ?? "")));
      return;
    }
    if (node.type === "element" && node.tagName === "br") {
      fragments.push(take(" "));
      return;
    }
    if (node.type !== "root" && node.type !== "element") return;
    const separates = node.type === "root" || PREVIEW_SEPARATED.has(node.tagName);
    let first = true;
    for (const child of node.children as ElementContent[]) {
      if (remaining === 0) break;
      if (child.type === "text" && child.value.trim() === "" && separates) continue;
      if (!first && separates) fragments.push(take(" "));
      first = false;
      visit(child);
    }
  };
  visit(tree);
  flush();
  const head = children[0];
  const tail = children.at(-1);
  if (head?.type === "text") head.value = head.value.trimStart();
  if (tail?.type === "text") tail.value = tail.value.trimEnd();
  const visible = children.some((child) => child.type !== "text" || child.value);
  return {
    type: "root",
    children: visible ? children : [{ type: "text", value: preview.fallback }],
  };
}

/** Links become their text, images their alt text, inline code plain text, Mermaid plain code. */
function makeInert(node: Root | Element) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "element") continue;
    if (child.tagName === "a") {
      children.splice(index, 1, ...child.children);
      index--;
      continue;
    }
    if (child.tagName === "img") {
      children[index] = { type: "text", value: String(child.properties.alt ?? "") };
      continue;
    }
    if (child.tagName === "code" && child.properties.dataInlineCode !== undefined) {
      children[index] = { type: "text", value: textOf(child) };
      continue;
    }
    if (
      child.tagName === "code" &&
      String(child.properties.className ?? "").includes("language-mermaid")
    ) {
      child.properties.className = ["language-text"];
    }
    makeInert(child);
  }
}

function isFootnotesSection(node: Root["children"][number]): boolean {
  return (
    node.type === "element" &&
    node.tagName === "section" &&
    node.properties.dataFootnotes !== undefined
  );
}

function isFootnoteSeedParagraph(node: Root["children"][number]): boolean {
  if (node.type !== "element" || node.tagName !== "p") return false;
  let hasRef = false;
  for (const child of node.children) {
    if (child.type === "text") {
      if (child.value.trim() !== "") return false;
      continue;
    }
    if (
      child.type === "element" &&
      child.tagName === "sup" &&
      child.children.length === 1 &&
      child.children[0]?.type === "element" &&
      child.children[0].tagName === "a" &&
      child.children[0].properties.dataFootnoteRef !== undefined
    ) {
      hasRef = true;
      continue;
    }
    return false;
  }
  return hasRef;
}

function applyFootnoteMode(hast: Root, mode: NonNullable<MarkdownExtensions["footnotes"]>) {
  if (mode === "only") {
    hast.children = hast.children.filter(isFootnotesSection);
    return;
  }
  let droppedSeed = mode !== "omit-seeded";
  const kept: Root["children"] = [];
  for (const child of hast.children) {
    if (isFootnotesSection(child)) continue;
    if (!droppedSeed && isFootnoteSeedParagraph(child)) {
      droppedSeed = true;
      continue;
    }
    if (kept.length === 0 && child.type === "text" && child.value.trim() === "") continue;
    kept.push(child);
  }
  while (kept.length > 0) {
    const tail = kept.at(-1);
    if (tail?.type === "text" && tail.value.trim() === "") kept.pop();
    else break;
  }
  hast.children = kept;
}

/** ChatMarkdown's sanitized hast for `text`, rendered by Words. */
export function wordsHast(text: string, options: WordsHastOptions): Root {
  const { extensions } = options;
  const renderOptions: RenderOptions = {
    math: options.math,
    // llm-math's `\(…\)` and `\[…\]`, which agents write as often as `$`.
    texDelimiters: options.math,
    autolinkBoundaries: true,
    // CommonMark's flanking rules leave `**文本。**后续` unclosed; this lets CJK emphasis close.
    cjk: true,
    singleTilde: !extensions.userMessage,
    leadingWhitespace: extensions.leadingWhitespace === true,
    windowsPaths: true,
    codeMeta: true,
    directives: CODEX_DIRECTIVES,
    // Previews and inert Markdown drop raw HTML, as their remark plugins dropped html nodes.
    ...(extensions.preview || extensions.inert
      ? { skipHtml: true }
      : { escapeHtml: options.escapeHtml }),
  };
  const insights = options.insights ? insightSource(text, renderOptions) : null;
  const source = insights?.source ?? text;
  const tree = insights?.tree ?? parse(source, renderOptions);
  let documentDefinitions: string[] | undefined;
  const walk: Walk = {
    definitions: (markdown) =>
      [
        ...markdownReferenceDefinitions(markdown),
        ...(documentDefinitions ??= markdownReferenceDefinitions(source)),
      ]
        .map((definition) => `${definition}\n\n`)
        .join(""),
    render: (markdown, indent) =>
      parse(markdown, {
        ...renderOptions,
        leadingWhitespace: extensions.leadingWhitespace === true && { indent },
      }),
    source,
    options,
    math: new Map(),
    mathKey: `t3-math-${Math.random().toString(36).slice(2)}`,
    insightMarker: insights?.marker ?? null,
  };
  transform(tree, walk, false, false);
  preserveImageSourceMeta(tree as never);
  normalizeLocalFileLinks(tree as never);
  const hast = sanitizeChatHast(tree);
  if (walk.math.size > 0) restoreMath(hast, walk.math);
  if (insights) restorePositions(hast, insights.toOriginal);
  if (extensions.footnotes) applyFootnoteMode(hast, extensions.footnotes);
  if (extensions.inert) makeInert(hast);
  if (extensions.preview) return flattenPreview(hast, extensions.preview);
  addHeadingIds(hast);
  addTextDirection(hast as never);
  groupChipPunctuation(hast as never);
  return hast;
}

export interface CodexDirectiveSource {
  readonly name: string;
  readonly attributes: Record<string, string>;
  /** UTF-16 offsets of the whole directive in the source. */
  readonly start: number;
  readonly end: number;
  /** The label's text as written. */
  readonly label: string;
  /** Inside a link, where a file citation stays text. */
  readonly inLink: boolean;
}

/** The Codex directives in `markdown`, as Words reads them. */
export function codexDirectiveSources(markdown: string): CodexDirectiveSource[] {
  const found: CodexDirectiveSource[] = [];
  const visit = (node: Root | Element, inLink: boolean) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const name = child.properties.dataDirective;
      if (typeof name === "string" && child.position) {
        const { start, end } = child.position;
        const hasLabel = textOf(child).trim().length > 0;
        found.push({
          name,
          attributes: directiveAttributes(child),
          start: start.offset!,
          end: end.offset!,
          label: hasLabel ? directiveLabel(markdown.slice(start.offset, end.offset)) : "",
          inLink,
        });
        if (name === "codex-followup" && !hasLabel) continue;
      }
      visit(child, inLink || child.tagName === "a");
    }
  };
  visit(
    parse(markdown, {
      windowsPaths: true,
      autolinkBoundaries: true,
      directives: CODEX_DIRECTIVES,
    }),
    false,
  );
  return found;
}

/** The label of a directive as written, `:name[label]{…}`: brackets nest in it, and `\` escapes. */
function directiveLabel(written: string): string {
  const open = written.indexOf("[");
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < written.length; index++) {
    const character = written[index];
    if (character === "\\") index++;
    else if (character === "[") depth++;
    else if (character === "]" && --depth === 0) return written.slice(open + 1, index);
  }
  return "";
}

/**
 * Words' HTML for `markdown` as hast, unsanitized and without the chat's additions. Code blocks,
 * links, list items and math carry source positions.
 */
export function markdownTree(
  markdown: string,
  options: { skipHtml?: boolean; singleTilde?: boolean; math?: boolean } = {},
): Root {
  return parse(markdown, {
    windowsPaths: true,
    autolinkBoundaries: true,
    cjk: true,
    skipHtml: options.skipHtml === true,
    singleTilde: options.singleTilde !== false,
    math: options.math === true,
    texDelimiters: options.math === true,
  });
}

/** The formulas Words reads in `text`, as source offsets, for editors that keep math as source. */
export function markdownMathRanges(text: string): Array<{ start: number; end: number }> {
  if (!/[$\\]|(?:`{3,}|~{3,})[ \t]*math\b/.test(text)) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "svg") {
        if (child.position) {
          ranges.push({ start: child.position.start.offset!, end: child.position.end.offset! });
        }
        continue;
      }
      visit(child);
    }
  };
  visit(parse(text, { math: true, texDelimiters: true }));
  return ranges;
}

/** The HTML comments Words reads as raw HTML in `markdown`, not as code or text, as source offsets. */
export function markdownHtmlComments(markdown: string): Array<{ start: number; end: number }> {
  const openers = [...markdown.matchAll(/<!--(?!-?>)/g)].map((match) => match.index);
  if (openers.length === 0) return [];
  // A mark after each opener keeps a comment a comment; Words writes only real ones unescaped.
  let marked = "";
  let from = 0;
  for (const [index, at] of openers.entries()) {
    marked += `${markdown.slice(from, at + 4)}\uE000${index}\uE001`;
    from = at + 4;
  }
  const html = decoder.decode(renderToHtml(marked + markdown.slice(from), { windowsPaths: true }));
  return [...html.matchAll(/<!--\uE000(\d+)\uE001/g)].map((match) => {
    const start = openers[Number(match[1])]!;
    const close = markdown.indexOf("-->", start + 4);
    return { start, end: close < 0 ? markdown.length : close + 3 };
  });
}

/**
 * The first definition of each label in `markdown`, as one line of Markdown. Words decides which
 * `[label]:` text defines one: each label is looked up before the text so an unclosed trailing
 * block cannot consume the lookups.
 */
export function markdownReferenceDefinitions(markdown: string): string[] {
  const labels = new Map<string, string>();
  for (const match of markdown.matchAll(/\[((?:[^\\[\]]|\\.){1,999})\]:/g)) {
    const label = match[1]!.replace(/[ \t\r\n\f\v]+/g, " ");
    const key = label.trim().toLowerCase();
    // `[^1]:` is a footnote.
    if (key !== "" && !key.startsWith("^") && !labels.has(key)) labels.set(key, label);
  }
  if (labels.size === 0) return [];
  let probe = "";
  const lookups = new Map<number, string>();
  for (const label of labels.values()) {
    lookups.set(probe.length, label);
    probe += `[${label}]\n\n`;
  }
  probe += markdown.replace(/^\uFEFF/, "");
  const definitions: string[] = [];
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const label = lookups.get(child.position?.start.offset ?? -1);
      if (child.tagName === "a" && label !== undefined) {
        const href = String(child.properties.href ?? "")
          .replace(/&/g, "&amp;")
          .replace(/[<>\\\n]/g, encodeURIComponent);
        const title = child.properties.title;
        definitions.push(
          `[${label}]: <${href}>${typeof title === "string" ? ` "${title.replace(/\s+/g, " ").replace(/["\\]/g, "\\$&").replace(/&/g, "&amp;")}"` : ""}`,
        );
      } else visit(child);
    }
  };
  visit(parse(probe, { windowsPaths: true }));
  return definitions;
}
