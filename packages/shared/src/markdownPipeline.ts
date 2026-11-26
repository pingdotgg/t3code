import type {
  Heading,
  Link,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  Text,
} from "mdast";
import { remarkKeepWindowsPaths } from "./markdownWindowsPaths.ts";
import { type PluggableList, type Processor, type Transformer, unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { find, html } from "property-information";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import { remarkKeepOrderedListNumbers } from "./markdownOrderedListNumbers.ts";
import {
  remarkEnableLeadingWhitespace,
  remarkKeepLeadingWhitespace,
} from "./markdownLeadingWhitespace.ts";
import { remarkCodexDirectives } from "./codexMarkdownDirectives.ts";
import { absoluteFilePathMatches } from "./markdownLinks.ts";
import { isWindowsAbsolutePath } from "./path.ts";
import {
  CHAT_MARKDOWN_SANITIZE_SCHEMA,
  chatMarkdownImageSource,
  rehypeNormalizeLocalFileLinks,
  rehypePreserveImageSourceMeta,
  type ChatMarkdownImageProperties,
} from "./markdownHast.ts";

export { chatMarkdownImageSource, type ChatMarkdownImageProperties };

export { remarkEnableOrderedListNumbers } from "./markdownOrderedListNumbers.ts";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

// Whole tags, attributes, and comments, so closing-anchor text inside them never counts as a tag.
const RAW_HTML_TAG_PATTERN = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;

function rehypePreserveBareAnchorPlaceholders() {
  return (tree: MarkdownImageHastNode) => {
    const anchors: Array<MarkdownImageHastNode | null> = [];
    let rawTextTag: string | undefined;
    const visit = (node: MarkdownImageHastNode) => {
      if (node.type === "raw" && typeof node.value === "string") {
        const tags = new RegExp(RAW_HTML_TAG_PATTERN);
        let offset = 0;
        while (rawTextTag !== "plaintext") {
          // Raw text ends at its closing tag even inside comment-looking text.
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, "gi") : tags;
          matcher.lastIndex = offset;
          const match = matcher.exec(node.value);
          if (!match) break;
          const [tag] = match;
          offset = matcher.lastIndex;
          if (rawTextTag) {
            rawTextTag = undefined;
            continue;
          }
          if (tag.startsWith("<!--")) continue;
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          ) {
            rawTextTag = opening;
          } else if (opening === "a") {
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
          } else if (closing === "a") {
            anchors.pop();
          }
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    for (const anchor of anchors) {
      if (anchor) anchor.type = "text";
    }
  };
}

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkEndAutolinksAtScriptPunctuation,
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkKeepOrderedListNumbers,
  remarkNormalizeListItemIndentation,
  remarkLinkAbsoluteFilePaths,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

// Leading whitespace is kept only where each line renders as a line.
export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkEndAutolinksAtScriptPunctuation,
  remarkKeepAutolinkSuffixes,
  remarkKeepLeadingWhitespace,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkKeepOrderedListNumbers,
  remarkNormalizeListItemIndentation,
  remarkLinkAbsoluteFilePaths,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

// Users type paths like ~/a and (~/b, which GFM's single-tilde strikethrough hides as <del>.
// Appended after the base list, this reconfigures its remark-gfm entry; ~~double~~ still strikes.
// Users also indent lines with spaces, which CommonMark drops from a paragraph.
export const CHAT_USER_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkEnableLeadingWhitespace,
];

// Start tags an HTML parser closes an open `<p>` for.
const CLOSES_PARAGRAPH = new Set(
  "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p plaintext pre search section summary table ul xmp dd dt".split(
    " ",
  ),
);
const HEADING = /^h[1-6]$/;

interface HtmlScope {
  readonly anchor: boolean;
  readonly paragraph: boolean;
  readonly heading: boolean;
}

/**
 * Whether the tree needs the HTML parser: raw HTML, or nesting it repairs (a footnote call in a
 * link label nests `<a>`). Otherwise it only rewrites properties as hast-util-to-parse5 does and
 * drops `data`, both repeated here, and moves blank text that renders the same.
 */
function needsHtmlParser(node: MarkdownImageHastNode, scope: HtmlScope): boolean {
  if (node.type === "raw") return true;
  let inner = scope;
  if (node.type === "element" && node.tagName) {
    const { tagName } = node;
    const heading = HEADING.test(tagName);
    if (
      (tagName === "a" && scope.anchor) ||
      (scope.paragraph && CLOSES_PARAGRAPH.has(tagName)) ||
      (heading && scope.heading)
    ) {
      return true;
    }
    inner = {
      anchor: scope.anchor || tagName === "a",
      paragraph: scope.paragraph || tagName === "p",
      heading: scope.heading || heading,
    };
    const properties = node.properties ?? {};
    for (const key of Object.keys(properties)) {
      const value = properties[key];
      const info = find(html, key);
      if (
        value === false ||
        value === null ||
        value === undefined ||
        Number.isNaN(value) ||
        (!value && info.boolean)
      ) {
        delete properties[key];
      } else if (value === true && !info.boolean && !info.overloadedBoolean) {
        properties[key] = "";
      }
    }
    delete (node as { data?: unknown }).data;
  }
  return (node.children ?? []).some((child) => needsHtmlParser(child, inner));
}

const TOP_SCOPE: HtmlScope = { anchor: false, paragraph: false, heading: false };

/** rehype-raw reparses the whole tree through an HTML parser, which most trees can skip. */
function rehypeRawWhenPresent(this: Processor) {
  const transform = rehypeRaw.call(this) as unknown as (
    tree: MarkdownImageHastNode,
    file: unknown,
  ) => unknown;
  return (tree: MarkdownImageHastNode, file: unknown) =>
    needsHtmlParser(tree, TOP_SCOPE) ? transform(tree, file) : undefined;
}

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypePreserveBareAnchorPlaceholders,
  rehypeRawWhenPresent,
  rehypePreserveImageSourceMeta,
  rehypeNormalizeLocalFileLinks,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

const isImageNode = (node: PhrasingContent | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children.length === 1 &&
    isImageNode(node.children[0]));
const endsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /\n[ \t]*$/.test(node.value));
const startsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*\n/.test(node.value));

// A caption line ending in a screenshot reads as a figure, so the trailing images get a line.
function trailingImagesStart(children: readonly PhrasingContent[]): number | undefined {
  let start: number | undefined;
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (isImageNode(child)) start = index;
    else if (child.type !== "break" && !(child.type === "text" && !child.value.trim()))
      return start;
  }
  return undefined;
}

function breakLinesAroundImages(paragraph: Paragraph) {
  const children = paragraph.children;
  if (!children.some(isImageNode)) return;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  const trailingStart = trailingImagesStart(children);
  paragraph.children = children.flatMap((child, index): PhrasingContent[] => {
    // Kept indentation after a line ending already sits on a line of its own.
    const beforeTrailing =
      index + 1 === trailingStart &&
      !(child.type === "text" && !child.value.trim() && endsLine(children[index - 1]));
    if (child.type !== "text") {
      return beforeTrailing && child.type !== "break" ? [child, { type: "break" }] : [child];
    }
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage && !beforeTrailing) return [child];
    const parts: PhrasingContent[] = [];
    let value = child.value;
    if (afterImage) {
      value = value.replace(/^[ \t]*\n/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = (beforeImage && /\n[ \t]*$/.test(value)) || beforeTrailing;
    if (breakAfter) value = value.replace(/[ \t]*(?:\n[ \t]*)?$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

/**
 * Agents label screenshots with a line like `**Palette**` right above the image. CommonMark
 * joins those lines into one paragraph, which puts the image inline beside its label. An
 * image alone on its source line keeps that line; prose and inline badges still wrap.
 */
function remarkBreakAroundImageLines() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkKeepAutolinkSuffixes(): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index];
        const next = node.children[index + 1];
        if (child?.type === "link" && /^https?:\/\//i.test(child.url) && next?.type === "text") {
          const suffix = /^[_~]+/.exec(next.value)?.[0];
          if (!suffix) continue;
          const label = child.children.length === 1 ? child.children[0] : undefined;
          if (label?.type !== "text") continue;
          if (label.value !== child.url && `http://${label.value}` !== child.url) continue;
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const bare =
            !child.position ||
            (start !== undefined &&
              end !== undefined &&
              source.slice(start, end) === label.value &&
              source.slice(end, end + suffix.length) === suffix);
          if (bare) {
            child.url += suffix;
            label.value += suffix;
            next.value = next.value.slice(suffix.length);
            if (child.position && end !== undefined) {
              const boundary = {
                ...child.position.end,
                column: child.position.end.column + suffix.length,
                offset: end + suffix.length,
              };
              child.position.end = boundary;
              if (label.position) label.position.end = boundary;
              if (next.position) next.position.start = boundary;
            }
            if (!next.value) node.children.splice(index + 1, 1);
          }
        }
        if (child) visit(child);
      }
    };
    visit(tree);
  };
}

// Punctuation and symbols from CJK Symbols and Punctuation and from Halfwidth and Fullwidth Forms,
// plus the Arabic-script comma, semicolon, question mark, and full stop.
const SCRIPT_PUNCTUATION = /(?=[　-〿＀-￯،؛؟۔])[\p{P}\p{S}]/u;

/**
 * GFM runs a bare URL on until whitespace, so Chinese, Japanese, and Arabic punctuation joins it,
 * along with the rest of the sentence and any `**` that should have closed around it. A URL that is
 * ASCII up to such a mark ends there. Unicode earlier in the URL means the mark may belong to it, so it stays.
 */
function scriptPunctuationIndex(link: Link): number {
  const label = link.children.length === 1 ? link.children[0] : undefined;
  if (label?.type !== "text" || !/^https?:\/\//i.test(link.url)) return -1;
  if (link.url !== label.value && link.url !== `http://${label.value}`) return -1;
  const index = label.value.search(/[^!-~]/u);
  return index > 0 && SCRIPT_PUNCTUATION.test(label.value.charAt(index)) ? index : -1;
}

/** GFM's text pass links bare URLs without positions; its tokenizer's links span their URL. */
function isBareLink(link: Link, source: string): boolean {
  const start = link.position?.start.offset;
  const end = link.position?.end.offset;
  const label = link.children[0];
  return (
    !link.position ||
    (start !== undefined &&
      end !== undefined &&
      label?.type === "text" &&
      source.slice(start, end) === label.value)
  );
}

/** Source offsets of the marks that tokenized bare URLs run past. */
function scriptPunctuationOffsets(node: RootContent, source: string): number[] {
  if (node.type === "link") {
    const index = scriptPunctuationIndex(node);
    const start = node.position?.start.offset;
    return index > 0 && start !== undefined && isBareLink(node, source) ? [start + index] : [];
  }
  return "children" in node && node.type !== "linkReference"
    ? (node.children as RootContent[]).flatMap((child) => scriptPunctuationOffsets(child, source))
    : [];
}

const hasReference = (node: RootContent): boolean =>
  node.type === "linkReference" ||
  node.type === "imageReference" ||
  node.type === "footnoteReference" ||
  ("children" in node && (node.children as RootContent[]).some(hasReference));

/** How many of the ascending numbers are below `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Parses the block's text again with a tab before each mark. The tab ends the URL as a space would,
 * so emphasis around the URL closes and later URLs and code get their own nodes. The tabs are then
 * dropped and positions mapped back to the source. Returns false and leaves the block alone when its
 * text would parse differently on its own, as a quote's continuation lines do.
 */
function reparseAtScriptPunctuation(
  processor: Processor,
  block: Paragraph | Heading | TableCell,
  source: string,
  offsets: number[],
): boolean {
  // A task item's paragraph starts at its checkbox; its first child starts after it.
  const from = block.children[0]?.position?.start;
  const to = block.children.at(-1)?.position?.end;
  if (from?.offset === undefined || to?.offset === undefined || hasReference(block)) return false;
  const base = from.offset;
  const text = source.slice(base, to.offset);
  // A tab is the marker, a quote's `>` on a later line would read as a new quote, a list's
  // indentation would join a code span, and only a table unescapes `\|` in code.
  if (
    text.includes("\t") ||
    /[\r\n][ ]*>/.test(text) ||
    (/[\r\n] /.test(text) && text.includes("`")) ||
    (block.type === "tableCell" && text.includes("\\|"))
  ) {
    return false;
  }
  const marks = offsets.map((offset) => offset - base);
  // Each pass finds the next URL in a run with no spaces, like `http://a，http://b，http://c`.
  for (let attempt = 0; attempt < 16; attempt++) {
    marks.sort((a, b) => a - b);
    const tabs = marks.map((mark, index) => mark + index);
    const unmarked = (offset: number) => offset - countBelow(tabs, offset);
    const marked = [0, ...marks]
      .map((start, index) => text.slice(start, marks[index] ?? text.length))
      .join("\t");
    const [paragraph, ...rest] = (processor.parse(marked) as Root).children;
    if (paragraph?.type !== "paragraph" || rest.length > 0) return false;
    const more = scriptPunctuationOffsets(paragraph, marked);
    if (more.length > 0) {
      marks.push(...more.map(unmarked));
      continue;
    }

    let tabCount = 0;
    const moved = new Set<object>();
    const restore = (node: RootContent): boolean => {
      for (const point of node.position ? [node.position.start, node.position.end] : []) {
        const offset = point.offset;
        if (offset === undefined || moved.has(point)) continue;
        moved.add(point);
        const tabsOnLine = countBelow(tabs, offset) - countBelow(tabs, offset - point.column + 1);
        point.column = (point.line === 1 ? from.column - 1 : 0) + point.column - tabsOnLine;
        point.line += from.line - 1;
        point.offset = base + unmarked(offset);
      }
      if (node.type === "text") {
        tabCount += node.value.split("\t").length - 1;
        node.value = node.value.replaceAll("\t", "");
      } else if (
        ("value" in node && node.value.includes("\t")) ||
        ("url" in node && node.url.includes("\t"))
      ) {
        return false;
      }
      if (!("children" in node)) return true;
      const children = node.children as RootContent[];
      if (!children.every(restore)) return false;
      node.children = children.filter(
        (child) => child.type !== "text" || child.value !== "",
      ) as typeof node.children;
      return true;
    };
    if (!restore(paragraph) || tabCount !== tabs.length) return false;
    block.children = paragraph.children;
    return true;
  }
  return false;
}

/** Ends the bare URLs a reparse could not, and those GFM's text pass linked after emphasis. */
function splitAtScriptPunctuation(node: RootContent, source: string) {
  if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
  const children = node.children as RootContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "link") {
      splitAtScriptPunctuation(child, source);
      continue;
    }
    const at = isBareLink(child, source) ? scriptPunctuationIndex(child) : -1;
    const label = child.children[0];
    if (at < 0 || label?.type !== "text") continue;
    // GFM drops this punctuation from the end of a URL; remarkKeepAutolinkSuffixes restores `_` and `~`.
    const length = label.value.slice(0, at).replace(/[!"'*,.:;?_~]+$/, "").length;
    const tail: Text = { type: "text", value: label.value.slice(length) };
    const start = child.position?.start;
    if (child.position && start?.offset !== undefined) {
      const end = {
        line: start.line,
        column: start.column + length,
        offset: start.offset + length,
      };
      tail.position = { start: end, end: child.position.end };
      child.position = { start, end };
      label.position = { start, end };
    }
    child.url = child.url.slice(0, child.url.length - label.value.length + length);
    label.value = label.value.slice(0, length);
    children.splice(index + 1, 0, tail);
    index++;
  }
}

function remarkEndAutolinksAtScriptPunctuation(this: Processor): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    if (!SCRIPT_PUNCTUATION.test(source)) return;
    const visit = (node: RootContent) => {
      if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
        const offsets = scriptPunctuationOffsets(node, source);
        if (offsets.length > 0) reparseAtScriptPunctuation(this, node, source, offsets);
        splitAtScriptPunctuation(node, source);
      } else if ("children" in node) {
        (node.children as RootContent[]).forEach(visit);
      }
    };
    tree.children.forEach(visit);
  };
}

function remarkLinkAbsoluteFilePaths(): Transformer<Root> {
  return (tree) => {
    // Raw `<a>` tags are sibling html nodes, so text inside one is not under a link node.
    let rawAnchorDepth = 0;
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      node.children = node.children.flatMap((child): typeof node.children => {
        if (child.type === "html") {
          for (const [tag] of child.value.matchAll(RAW_HTML_TAG_PATTERN)) {
            if (/^<a[\s/>]/i.test(tag)) rawAnchorDepth += 1;
            else if (/^<\/a[\s>]/i.test(tag)) rawAnchorDepth = Math.max(0, rawAnchorDepth - 1);
          }
        }
        if (child.type !== "text" || rawAnchorDepth > 0) {
          visit(child);
          return [child];
        }
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const { index, path } of absoluteFilePathMatches(child.value)) {
          if (index > offset) parts.push({ type: "text", value: child.value.slice(offset, index) });
          parts.push({ type: "link", url: path, children: [{ type: "text", value: path }] });
          offset = index + path.length;
        }
        if (offset === 0) return [child];
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
        const path = node.url.replace(/%5C/gi, "\\");
        if (/^[A-Za-z]:[\\/]/.test(path)) {
          node.url = `file:///${path.replaceAll("\\", "/")}`;
        }
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

export function remarkAssistantInsights(this: Processor) {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes("★ Insight")) return;
    const protectedRanges: { start: number; end: number; code: boolean }[] = [];
    const inspect = (node: RootContent | PhrasingContent) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const code =
          node.type === "code" ||
          node.type === "html" ||
          (node.type === "inlineCode" && node.position?.start.line !== node.position?.end.line);
        if (code || node.type === "list" || node.type === "blockquote")
          protectedRanges.push({ start, end, code });
      }
      if ("children" in node) node.children.forEach(inspect);
    };
    tree.children.forEach(inspect);
    const starts = new Set<number>();
    const offsets: { original: number; rewritten: number; prefix: number }[] = [];
    let indent: string | undefined;
    let original = 0;
    let rewritten = 0;
    const lines = source.split(/(?<=\n)|(?<=\r)(?!\n)/u).map((line, index) => {
      const value = line.replace(/[\r\n]+$/u, "");
      const blocked = protectedRanges.some(
        (range) =>
          original >= range.start && original < range.end && (indent === undefined || range.code),
      );
      const opening =
        indent === undefined && !blocked
          ? /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u.exec(value)
          : null;
      const closing =
        indent !== undefined && !blocked ? /^( {0,3})(`?)─{3,}\2[ \t]*$/u.exec(value) : null;
      let prefix = 0;
      let output = line;
      if (opening) {
        indent = opening[1] ?? "";
        starts.add(index + 1);
        output = ">" + line.slice(value.length);
      } else if (closing && closing[1] === indent) {
        indent = undefined;
        output = line.slice(value.length);
      } else if (indent !== undefined) {
        prefix = 2;
        output = "> " + line;
      }
      offsets.push({ original, rewritten, prefix });
      original += line.length;
      rewritten += output.length;
      return output;
    });
    if (starts.size === 0) return;
    const parsed = this.parse(lines.join("")) as Root;
    const restorePosition = (node: RootContent | PhrasingContent) => {
      if (node.position) {
        for (const point of [node.position.start, node.position.end]) {
          const offset = offsets[point.line - 1];
          if (!offset) continue;
          point.column = Math.max(1, point.column - offset.prefix);
          if (point.offset !== undefined)
            point.offset += offset.original - offset.rewritten - offset.prefix;
        }
      }
      if ("children" in node) node.children.forEach(restorePosition);
    };
    for (const node of parsed.children) {
      if (node.type === "blockquote" && starts.has(node.position?.start.line ?? 0)) {
        node.data = { ...node.data, hProperties: { dataAlert: "insight" } };
      }
      restorePosition(node);
    }
    tree.children = parsed.children;
  };
}

const imageSourceProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

interface ImageSourceNode {
  readonly type: string;
  readonly tagName?: string;
  readonly properties?: ChatMarkdownImageProperties;
  readonly children?: ReadonlyArray<ImageSourceNode>;
}

/**
 * Collect the fallback and every theme variant so images are available to all viewers.
 */
export function chatMarkdownImageSources(markdown: string): Array<string> {
  const sources: Array<string> = [];
  const visit = (node: ImageSourceNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const properties = node.properties;
      const fallback = chatMarkdownImageSource(properties);
      if (fallback) sources.push(fallback.classifiedSrc);
      for (const [theme, variant] of [
        ["dark", properties?.dataDarkSrc],
        ["light", properties?.dataLightSrc],
      ] as const) {
        if (typeof variant !== "string") continue;
        const source = chatMarkdownImageSource(properties, theme);
        if (source) sources.push(source.classifiedSrc);
      }
    }
    node.children?.forEach(visit);
  };
  visit(imageSourceProcessor.runSync(imageSourceProcessor.parse(markdown)) as ImageSourceNode);
  return sources;
}

const linkDestinationProcessor = unified().use(remarkParse).use(remarkKeepWindowsPaths);

// An angle destination cannot hold an unescaped `<` or `>`, or end on a lone backslash.
const ANGLE_DESTINATION_CONTENT = /^(?:[^\\<>]|\\.)*$/;

/** Reads a destination from `extractMarkdownLinkHrefs` as the renderer's parser does. */
export function decodeMarkdownLinkEscapes(href: string): string {
  // Only the parser knows character references, so destinations that may have one go through it.
  if (href.includes("&")) {
    // The extractor drops angle brackets, and only that form keeps an unmatched `)` in the path.
    const destination = ANGLE_DESTINATION_CONTENT.test(href) ? `<${href}>` : href;
    const paragraph = linkDestinationProcessor.parse(`[](${destination})`).children[0];
    const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    if (link?.type === "link") return link.url;
  }
  return isWindowsAbsolutePath(href) ? href : href.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}
