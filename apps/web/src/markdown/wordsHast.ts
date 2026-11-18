import type { Element, ElementContent, Root, Text } from "hast";
import { renderToHtml } from "@pierre/words";
import { decodeHTML } from "entities";
import { find, html as htmlSchema, svg as svgSchema } from "property-information";
import { resolveCodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { resolveCodexFileCitationLink } from "@t3tools/shared/codexFileCitations";
import { absoluteFilePathMatches } from "@t3tools/shared/markdownLinks";
import {
  rehypeNormalizeLocalEditorLinks,
  rehypePreserveImageSourceMeta,
  sanitizeChatHast,
} from "@t3tools/shared/markdownPipeline";

import { rehypeChipPunctuation } from "../components/chat/markdownChipPunctuation";
import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { rehypeTextDirection } from "../components/chat/markdownTextDirection";

export interface WordsHastOptions {
  /** `$…$`, `$$…$$` and `math` code blocks render as SVG. */
  readonly math: boolean;
  /** Soft line breaks render as `<br>`, as remark-breaks does. */
  readonly breaks: boolean;
  /** A single `~` strikes through, as remark-gfm's default does. */
  readonly singleTilde: boolean;
  /** Ordered list items keep a written number that breaks the sequence (keepOrderedListNumbers). */
  readonly listNumbers: boolean;
}

const CODEX_DIRECTIVES = ["codex-file-citation", "codex-followup", "artifact-template"];

const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
// The HTML parser reads their content as text, which this tokenizer does not model.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed"]);

const TAG =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--(?:-?>|[\s\S]*?-->)|<![^>]*>|<\?[\s\S]*?\?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const decoder = new TextDecoder();
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
    const value = decode(raw);
    result[info.property] =
      info.spaceSeparated || info.commaSeparated
        ? value.split(info.commaSeparated ? "," : /\s+/).filter(Boolean)
        : info.boolean
          ? true
          : value;
  }
  return result;
}

/** Markdown images Words wrote, as `<img src=… alt=… />`; raw HTML images keep their own form. */
const markdownImages = new WeakSet<Element>();

/**
 * Hast for Words' HTML. Its own markup is well formed; raw HTML closes where its end tags say,
 * and is sanitized afterwards, so a misnested tag can only change structure, never safety.
 */
function tokenize(html: string, offsetOf: (byte: number) => number): Root | null {
  const root: Root = { type: "root", children: [] };
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
    if (RAW_TEXT.has(tagName)) return null;
    if (match[1]) {
      if (tagName === "a") anchors.pop();
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
    }
    if (tagName === "img" && match[4] && /^\s+src=/.test(match[3] ?? "")) {
      markdownImages.add(element);
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
  return root;
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

const isMarkdownImage = (node: unknown) => isElement(node, "img") && markdownImages.has(node);

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
const MATH_STYLE = /^(?:display|vertical-align|overflow|margin)$/;

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

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

interface Walk {
  /** Words' hast for more Markdown, rendered with the same options. */
  readonly render: (markdown: string) => Root | null;
  readonly source: string;
  readonly options: WordsHastOptions;
  readonly math: Map<string, Element>;
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

/** remarkCodexDirectives: what a directive Words parsed becomes, as the remark plugin builds it. */
function codexDirective(node: Element, walk: Walk, inLink: boolean): ElementContent {
  const name = node.properties.dataDirective;
  let attributes: Record<string, string> = {};
  try {
    attributes = JSON.parse(String(node.properties.dataAttributes ?? "{}"));
  } catch {}
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

const INLINE_PREFIX = "t3-markdown-inline-prefix:";

/**
 * remarkNormalizeListItemIndentation: four spaces after a list marker make indented code, but
 * agents mean wide indentation, so code starting on the marker's line is Markdown again.
 */
function recoverIndentedCode(item: Element, walk: Walk) {
  const code = item.children.find((child) => child.type === "element");
  const start = code?.position?.start.offset;
  const itemStart = item.position?.start.offset;
  if (!isElement(code, "pre") || start === undefined || itemStart === undefined) return;
  if (!/^[\t ]/.test(textOf(code))) return;
  if (walk.source.slice(itemStart, start).includes("\n") || /[`~]/.test(walk.source[start]!)) {
    return;
  }
  // The prefix keeps block syntax at the start, such as `#`, from opening a block.
  const recovered = walk.render(`${INLINE_PREFIX}${textOf(code).trim()}`);
  const paragraph = recovered?.children.find((child) => child.type === "element");
  const first = isElement(paragraph, "p") ? paragraph.children[0] : undefined;
  if (!recovered || first?.type !== "text" || !first.value.startsWith(INLINE_PREFIX)) return;
  first.value = first.value.slice(INLINE_PREFIX.length);
  if (first.value === "") paragraph!.children.shift();
  const blocks = recovered.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  ) as ElementContent[];
  item.children.splice(item.children.indexOf(code), 1, ...blocks);
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
function transform(node: Root | Element, walk: Walk, inLink: boolean, inCode: boolean) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "text") {
      if (inLink || inCode) continue;
      const parts: ElementContent[] = [];
      let offset = 0;
      // remarkLinkAbsoluteFilePaths
      for (const { index: at, path } of absoluteFilePathMatches(child.value)) {
        if (at > offset) parts.push({ type: "text", value: child.value.slice(offset, at) });
        parts.push({
          type: "element",
          tagName: "a",
          properties: { href: path },
          children: [{ type: "text", value: path }],
        });
        offset = at + path.length;
      }
      if (offset === 0) continue;
      if (offset < child.value.length) {
        parts.push({ type: "text", value: child.value.slice(offset) });
      }
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
      continue;
    }
    if (child.type !== "element") continue;
    if (child.properties.dataDirective !== undefined) {
      children[index] = codexDirective(child, walk, inLink);
      index--;
      continue;
    }
    const { tagName, properties: props } = child;
    if (tagName === "svg") {
      // Sanitizing drops SVG, so math waits under a placeholder until after it.
      const clean = walk.options.math ? sanitizeMath(child) : null;
      if (clean) {
        const key = `t3-math-${walk.math.size}`;
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
      props.src = windowsPath(props.src) ?? normalizeUri(props.src);
    } else if (tagName === "code" && isElement(node, "pre")) {
      if (props.dataMeta !== undefined) {
        props.dataCodeMeta = props.dataMeta;
        delete props.dataMeta;
      }
    } else if (tagName === "code" && !inLink) {
      props.dataInlineCode = "";
    } else if (tagName === "ol" && walk.options.listNumbers) {
      keepListNumbers(child, walk.source);
    } else if (tagName === "li" && isElement(child.children.find(isElementNode), "pre")) {
      recoverIndentedCode(child, walk);
    } else if (tagName === "li" && isElement(child.children[0], "input")) {
      props.className = ["task-list-item"];
      const { checked } = child.children[0].properties;
      child.children[0].properties = { type: "checkbox", checked, disabled: true };
      if (node.type === "element") node.properties.className = ["contains-task-list"];
    } else if (tagName === "p") {
      breakLines(child, walk.options.breaks);
    } else if (tagName === "blockquote") {
      // remarkGithubAlerts
      const paragraph = child.children.find((item) => item.type === "element");
      const first = isElement(paragraph, "p") ? paragraph.children[0] : undefined;
      const match = first?.type === "text" ? ALERT.exec(first.value) : null;
      if (match && first?.type === "text" && isElement(paragraph, "p")) {
        first.value = first.value.slice(match[0].length);
        if (first.value === "") paragraph.children.shift();
        if (paragraph.children.length === 0) {
          child.children.splice(child.children.indexOf(paragraph), 1);
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
function breakLines(paragraph: Element, breaks: boolean) {
  const items = paragraph.children;
  for (let at = 0; at < items.length; at++) {
    const item = items[at]!;
    if (item.type === "element" && breaks && item.tagName !== "code") breakLines(item, breaks);
    if (item.type !== "text" || !item.value.includes("\n")) continue;
    const afterImage = isMarkdownImage(items[at - 1]);
    const beforeImage = isMarkdownImage(items[at + 1]);
    const lines = item.value.split("\n");
    const parts: ElementContent[] = [];
    lines.forEach((line, index) => {
      const breaksHere =
        index > 0 &&
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

function restoreMath(node: Root | Element, math: Map<string, Element>) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "element") continue;
    const id = child.properties.id;
    const svg = typeof id === "string" ? math.get(id.replace(/^user-content-/, "")) : undefined;
    if (svg) children[index] = svg;
    else restoreMath(child, math);
  }
}

const addHeadingIds = rehypeHeadingIds();
const addTextDirection = rehypeTextDirection();
const preserveImageSourceMeta = rehypePreserveImageSourceMeta();
const normalizeLocalEditorLinks = rehypeNormalizeLocalEditorLinks();
const groupChipPunctuation = rehypeChipPunctuation();

/** ChatMarkdown's sanitized hast for `text`, rendered by Words; null when it needs remark. */
export function wordsHast(text: string, options: WordsHastOptions): Root | null {
  const html = renderToHtml(text, {
    math: options.math,
    singleTilde: options.singleTilde,
    windowsPaths: true,
    codeMeta: true,
    sourcePositions: true,
    directives: CODEX_DIRECTIVES,
  });
  const tree = tokenize(decoder.decode(html), utf16Offsets(text));
  if (!tree) return null;
  const walk: Walk = {
    render: (markdown) => {
      const rendered = renderToHtml(markdown, {
        math: options.math,
        singleTilde: options.singleTilde,
        windowsPaths: true,
        codeMeta: true,
        directives: CODEX_DIRECTIVES,
      });
      return tokenize(decoder.decode(rendered), utf16Offsets(markdown));
    },
    source: text,
    options,
    math: new Map(),
  };
  transform(tree, walk, false, false);
  preserveImageSourceMeta(tree as never);
  normalizeLocalEditorLinks(tree as never);
  const hast = sanitizeChatHast(tree as never) as unknown as Root;
  if (walk.math.size > 0) restoreMath(hast, walk.math);
  addHeadingIds(hast);
  addTextDirection(hast as never);
  groupChipPunctuation(hast as never);
  return hast;
}
