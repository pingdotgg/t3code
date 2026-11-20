import type { Root, RootContent } from "mdast";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkKeepWindowsProsePaths } from "@t3tools/shared/markdownWindowsPaths";
import {
  absoluteFilePathMatches,
  inlineCodeFilePathCandidate,
  parseMarkdownFileLink,
} from "@t3tools/shared/markdownLinks";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { hasRightToLeftLetter, textDirection } from "@t3tools/shared/textDirection";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkKeepWindowsProsePaths);
export type MarkdownNode = Root | RootContent;

interface MarkdownEdit {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

/** remark-parse omits one initial BOM from its source offsets, so they index the text after it. */
export function splitLeadingBom(markdown: string): readonly [bom: string, source: string] {
  return markdown.startsWith("\uFEFF") ? ["\uFEFF", markdown.slice(1)] : ["", markdown];
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  if (edits.length === 0) return markdown;
  const [bom, source] = splitLeadingBom(markdown);
  const parts: string[] = [bom];
  let offset = 0;
  // AST traversal emits disjoint edits in source order.
  for (const edit of edits) {
    parts.push(source.slice(offset, edit.start), edit.content);
    offset = edit.end;
  }
  parts.push(source.slice(offset));
  return parts.join("");
}

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

function markdownDestination(url: string): string {
  return `<${url.replace(/&/g, "\\&").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C").replace(/\n/g, "")}>`;
}

const ANCHOR_TAG = /^<\/?a[\s/>]/i;

/** Replacements for the anchor tags still ahead, and how many emitted links are open. */
type AnchorState = { readonly pending: string[]; open: number };

// Code spans keep their text; an odd trailing backslash would escape the closing "]".
function escapeLinkLabel(text: string): string {
  return text
    .replace(/(`+)[\s\S]*?\1|\\*[[\]]/g, (match) =>
      match.startsWith("`") || match.length % 2 === 0
        ? match
        : `${match.slice(0, -1)}\\${match.slice(-1)}`,
    )
    .replace(/\\+$/, (slashes) => (slashes.length % 2 ? `${slashes}\\` : slashes));
}

// An unescaped "!" before the inserted "[" would turn the link into an image.
function bangBefore(text: string, index: number): boolean {
  if (text[index - 1] !== "!") return false;
  let backslashes = 0;
  while (text[index - 2 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Pairs `<a>` tags in order. Only a closed anchor with an http(s) or mailto href becomes a
 * Markdown link; any other anchor keeps its text unlinked.
 */
function anchorMarkdown(tags: readonly string[]): AnchorState {
  const replacements = tags.map(() => "");
  const open: Array<{ index: number; href: string | undefined }> = [];
  tags.forEach((tag, index) => {
    if (tag[1] !== "/") {
      const href = attribute(tag, "href")?.trim();
      open.push({ index, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined });
      return;
    }
    const opening = open.pop();
    if (!opening?.href) return;
    replacements[opening.index] = "[";
    replacements[index] = `](${markdownDestination(opening.href)})`;
  });
  return { pending: replacements, open: 0 };
}

export function markdownHtmlTags(content: string): RegExpExecArray[] {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (!fenced) continue;
      // An unclosed fence runs to the end of the content, so no later opener matters.
      codeRanges.push({ start: opening.index, end: content.length });
      break;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return tags.filter(
    (tag) => !codeRanges.some((range) => tag.index >= range.start && tag.index < range.end),
  );
}

/**
 * Called only for parsed HTML nodes, so Markdown code examples keep their literal tags.
 * `anchors` is shared across sibling inline HTML nodes because each of those carries a single tag.
 */
export function markdownHtmlContent(
  content: string,
  options: { readonly anchors?: AnchorState; readonly inTableCell?: boolean } = {},
): string {
  const tags = markdownHtmlTags(content);
  const anchors =
    options.anchors ??
    anchorMarkdown(tags.map((tag) => tag[0]).filter((tag) => ANCHOR_TAG.test(tag)));
  let result = "";
  let end = 0;
  for (const match of tags) {
    const text = content.slice(end, match.index);
    result += anchors.open > 0 ? escapeLinkLabel(text) : text;
    const replacement = htmlTagMarkdown(match[0], anchors, options);
    if (replacement === "[" && bangBefore(result, result.length))
      result = `${result.slice(0, -1)}\\!`;
    result +=
      anchors.open > 0 && /[\s[]/.test(result.at(-1) ?? "")
        ? replacement.replace(/^ /, "")
        : replacement;
    end = match.index + match[0].length;
  }
  const text = content.slice(end);
  return result + (anchors.open > 0 ? escapeLinkLabel(text) : text);
}

function htmlTagMarkdown(
  tag: string,
  anchors: AnchorState,
  options: { readonly inTableCell?: boolean },
): string {
  if (tag.startsWith("<!--")) return "";
  if (ANCHOR_TAG.test(tag)) {
    const replacement = anchors.pending.shift() ?? "";
    if (replacement === "[") anchors.open += 1;
    else if (replacement) anchors.open -= 1;
    return replacement;
  }
  if (/^<img\b/i.test(tag)) {
    const src = attribute(tag, "src");
    if (!src) return "";
    const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
    return `![${alt}](${markdownDestination(src)})`;
  }
  // A raw newline would end the table row; both parsers decode this reference to one inside the cell.
  const cellBreak = "&#10;";
  // A blank line inside an open link label would end the paragraph before its "]".
  const blockBreak = anchors.open > 0 ? " " : options.inTableCell ? cellBreak : "\n\n";
  if (/^<summary\b/i.test(tag)) return `${blockBreak}**`;
  if (/^<\/summary\s*>/i.test(tag)) return `**${blockBreak}`;
  if (/^<br\b/i.test(tag)) return options.inTableCell ? cellBreak : "  \n";
  if (/^<\/?(?:p|div|details)\b/i.test(tag)) return blockBreak;
  return "";
}

export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown)) return markdown;
  const [, source] = splitLeadingBom(markdown);
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, inTableCell: boolean, inLink: boolean) => {
    if (!("children" in node)) return;
    inTableCell ||= node.type === "tableCell";
    const children: readonly MarkdownNode[] = node.children;
    // Inline HTML arrives one tag per node, so anchors pair across phrasing siblings.
    const anchors =
      node.type === "root" || node.type === "blockquote" || node.type === "listItem"
        ? undefined
        : anchorMarkdown(
            children.flatMap((child) =>
              child.type === "html"
                ? markdownHtmlTags(child.value)
                    .map((tag) => tag[0])
                    .filter((tag) => ANCHOR_TAG.test(tag))
                : [],
            ),
          );
    for (const child of children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const linkLabel = inLink || (anchors?.open ?? 0) > 0;
      if (child.type === "text") {
        if (linkLabel && start !== undefined && end !== undefined) {
          const content = escapeLinkLabel(source.slice(start, end));
          if (content !== source.slice(start, end)) edits.push({ start, end, content });
        }
        continue;
      }
      if (child.type !== "html") {
        visit(child, inTableCell, linkLabel);
        continue;
      }
      const content = markdownHtmlContent(child.value, { anchors, inTableCell });
      if (start === undefined || end === undefined) continue;
      // Text before an outermost link is never edited, so this edit cannot overlap another.
      if (content.startsWith("[") && !linkLabel && bangBefore(source, start))
        edits.push({ start: start - 1, end: start, content: "\\!" });
      edits.push({ start, end, content });
    }
  };
  visit(parser.parse(markdown), false, false);
  return applyMarkdownEdits(markdown, edits);
}

/** Reference definitions as authored, one line each, so a Windows destination keeps its backslashes. */
export function markdownReferenceDefinitions(markdown: string): string[] {
  if (!markdown.includes("]:")) return [];
  // Flattened as the renderer does it: a raw HTML block hides the definitions inside it.
  const flattened = markdownWithHtml(markdown);
  const [, source] = splitLeadingBom(flattened);
  const definitions: string[] = [];
  const visit = (node: MarkdownNode, quotes: number) => {
    if (node.type === "definition") {
      // A wrapped definition drops its indent and the enclosing quotes' markers, not a literal ">".
      const wrap = new RegExp(`(?:\\r\\n|\\r|\\n)(?:[ \\t]*>){0,${quotes}}[ \\t]*`, "g");
      definitions.push(
        source.slice(node.position?.start.offset, node.position?.end.offset).replace(wrap, " "),
      );
    }
    if (!("children" in node)) return;
    for (const child of node.children) visit(child, quotes + (node.type === "blockquote" ? 1 : 0));
  };
  visit(parser.parse(flattened), 0);
  return definitions;
}

/**
 * A reply split into folds and cards renders each fragment as its own document, so each one
 * carries the reply's definitions. The first definition of a label wins, so the fragment's own
 * lead: the renderer then prefers them by its own label matching, with none reimplemented here.
 */
export function withReferenceDefinitions(
  fragment: string,
  replyDefinitions: ReadonlyArray<string>,
): string {
  if (replyDefinitions.length === 0 || !fragment.includes("[")) return fragment;
  const definitions = new Set([...markdownReferenceDefinitions(fragment), ...replyDefinitions]);
  return `${[...definitions].join("\n")}\n\n${fragment}`;
}

// Start only at the beginning of a backtick run to avoid retrying every suffix.
const INLINE_CODE_SPAN = /(?<!`)`+([^`\r\n]+)`+/g;

// The native regex stops at whitespace; the shared classifier decides paths with spaces.
function isInlineCodeFileLink(code: string, fileLink: RegExp): boolean {
  return fileLink.test(code) || (/\s/.test(code) && inlineCodeFilePathCandidate(code) !== null);
}

export function markdownWithInlineFileLinks(
  markdown: string,
  fileLink: RegExp,
  inlineCodeHrefs?: Set<string>,
): string {
  return transformNativeMarkdown(markdown, fileLink, false, inlineCodeHrefs);
}

function transformNativeMarkdown(
  markdown: string,
  fileLink: RegExp | undefined,
  tableBreaks: boolean,
  inlineCodeHrefs?: Set<string>,
): string {
  const breakTables = tableBreaks && mayHaveTableUnderText(markdown);
  let linkFiles = false;
  if (fileLink) {
    for (const [, code] of markdown.matchAll(INLINE_CODE_SPAN)) {
      if (isInlineCodeFileLink(code!.trim(), fileLink)) {
        linkFiles = true;
        break;
      }
    }
  }
  const linkProseFiles = fileLink !== undefined && absoluteFilePathMatches(markdown).length > 0;
  if (!linkFiles && !linkProseFiles && !breakTables) return markdown;
  const [, source] = splitLeadingBom(markdown);
  const edits: MarkdownEdit[] = [];
  const fileEdits: MarkdownEdit[] = [];
  let rewritesPipe = false;
  const visit = (node: MarkdownNode) => {
    if (linkFiles && node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const escaped = node.value.replace(/[\\[\]&]/g, "\\$&");
      const label = node.value.replace(/[\\[\]&*_`~]/g, "\\$&");
      if (
        start !== undefined &&
        end !== undefined &&
        fileLink !== undefined &&
        isInlineCodeFileLink(node.value, fileLink) &&
        parseMarkdownFileLink(node.value) !== null &&
        !/[<>]/.test(node.value)
      ) {
        const edit = {
          start,
          end,
          content: `[${label}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
        inlineCodeHrefs?.add(node.value);
        if (node.value.includes("|")) rewritesPipe = true;
      }
    } else if (
      linkProseFiles &&
      node.type === "text" &&
      node.position?.start.offset !== undefined
    ) {
      const start = node.position.start.offset;
      const raw = source.slice(start, node.position.end.offset);
      for (const { index, path } of absoluteFilePathMatches(raw)) {
        // Source offsets stay valid for paths whose own text needs no Markdown decoding.
        if (raw !== node.value && /[\\&]/.test(path)) continue;
        const escaped = path.replace(/[\\[\]&]/g, "\\$&");
        const edit = {
          start: start + index,
          end: start + index + path.length,
          content: `[${escaped}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
      }
    } else if (node.type !== "link" && node.type !== "linkReference" && "children" in node)
      node.children.forEach((child, index) => {
        const previous = node.children[index - 1];
        const start = child.position?.start;
        if (
          breakTables &&
          child.type === "table" &&
          previous?.type === "paragraph" &&
          start?.offset !== undefined &&
          previous.position?.end.line === start.line - 1
        ) {
          let lineStart = start.offset;
          while (lineStart > 0 && !/[\r\n]/.test(source[lineStart - 1]!)) lineStart -= 1;
          // Replace only the container prefix, leaving cell edits disjoint from the table break.
          const [, header = "", , ending = "\n", markers = ""] =
            /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(source.slice(lineStart)) ?? [];
          edits.push({
            start: lineStart,
            end: lineStart + header.length,
            content: `${markers.trimEnd()}${ending}${markers}`,
          });
        }
        visit(child);
      });
  };
  visit(parser.parse(markdown));
  // Rewritten pipes can change table structure, so preserve the original pass ordering.
  if (breakTables && rewritesPipe)
    return markdownWithTableBreaks(applyMarkdownEdits(markdown, fileEdits));
  return applyMarkdownEdits(markdown, edits);
}

// A delimiter row such as `|---|:--:|`, possibly inside a blockquote or list item.
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/** md4c starts tables only at paragraph starts; insert breaks to match GFM. */
export function markdownWithTableBreaks(markdown: string): string {
  return transformNativeMarkdown(markdown, undefined, true);
}

// `>` covers a destination continued on a blockquote line.
const WINDOWS_DESTINATION = /\](?:\(|:)[\s>]*<?(?:[A-Za-z]:[\\/]|\\\\)/;

interface DestinationToken {
  readonly start: { readonly offset: number };
  readonly end: { readonly offset: number };
}

/**
 * Markdown reads `C:\work\.t3` as `C:\work.t3`. Web keeps authored Windows destinations
 * literally (see `remarkKeepWindowsPaths` in shared), so escape their backslashes to give
 * both parsers here the same path. `\&` stays an escape, as `markdownWithHtml` emits it.
 * Expects authored Markdown: already escaped output would be escaped twice.
 */
function markdownWithWindowsPathDestinations(markdown: string): string {
  // Skips the extra parse for the common message that has no Windows destination.
  if (!WINDOWS_DESTINATION.test(markdown)) return markdown;
  const [, source] = splitLeadingBom(markdown);
  const edits: MarkdownEdit[] = [];
  function record(
    this: { resume(): string; sliceSerialize(token: DestinationToken): string },
    token: DestinationToken,
  ) {
    this.resume();
    const authored = this.sliceSerialize(token);
    if (!isWindowsAbsolutePath(authored) || !authored.includes("\\") || /[<>]/.test(authored))
      return;
    const start = token.start.offset;
    const end = token.end.offset;
    const escaped = authored.replace(/\\(?!&)/g, "\\\\");
    // A bare destination ends at an unescaped `)`, so wrap it to keep `\)` inside.
    const angled = source[start - 1] === "<";
    edits.push({ start, end, content: angled ? escaped : `<${escaped}>` });
  }
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(function (this: Processor) {
      (this.data().fromMarkdownExtensions ??= []).push({
        exit: { resourceDestinationString: record, definitionDestinationString: record },
      });
    })
    .parse(markdown);
  return applyMarkdownEdits(markdown, edits);
}

// Only a bare image paragraph gets a native image slot; a linked one would draw full width.
const isImage = (node: MarkdownNode) => node.type === "image" || node.type === "imageReference";
const isSpace = (node: MarkdownNode) =>
  node.type === "break" || (node.type === "text" && node.value.trim() === "");

/**
 * Native Markdown sizes an image as a block only when it starts its paragraph. These are the
 * images web puts on their own line: one alone on its source line, and the images that end a
 * paragraph after its text, like a screenshot after its caption. A row of those can't sit side
 * by side natively, so each gets its own paragraph.
 */
function markdownWithImageParagraphs(markdown: string): string {
  if (!markdown.includes("![")) return markdown;
  const [, source] = splitLeadingBom(markdown);
  const edits = new Map<number, MarkdownEdit>();
  const split = (start: number, gap: string) => {
    const ending = /\r\n?|\n/.exec(gap)?.[0] ?? "\n";
    edits.set(start, { start, end: start + gap.length, content: ending.repeat(2) });
  };
  for (const block of parser.parse(markdown).children) {
    const blockStart = block.position?.start.offset;
    const blockEnd = block.position?.end.offset;
    if (block.type !== "paragraph" || blockStart === undefined || blockEnd === undefined) continue;
    let trailingStart: number | undefined;
    for (let index = block.children.length - 1; index >= 0; index--) {
      const child = block.children[index]!;
      if (isImage(child)) trailingStart = index;
      else if (!isSpace(child)) break;
    }
    block.children.forEach((child, index) => {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (!isImage(child) || start === undefined || end === undefined) return;
      const before = source.slice(blockStart, start);
      const after = source.slice(end, blockEnd);
      const ownsLine = /(?:^|\r|\n)[ \t]*$/.test(before) && /^[ \t]*\\?(?:\r\n?|\n|$)/.test(after);
      if (before.trim() && (ownsLine || (trailingStart !== undefined && index >= trailingStart))) {
        const gap = /[ \t]*(?:\\?(?:\r\n?|\n)[ \t]*)?$/.exec(before)![0];
        split(start - gap.length, gap);
      }
      if (ownsLine && after.trim()) split(end, /^[ \t]*\\?(?:\r\n?|\n)[ \t]*/.exec(after)![0]);
    });
  }
  return applyMarkdownEdits(
    markdown,
    [...edits.values()].sort((a, b) => a.start - b.start),
  );
}

// HTML wrappers can expose Markdown that wasn't in the first AST, so normalize them first.
function normalizedMarkdown(markdown: string): string {
  return markdownWithWindowsPathDestinations(markdownWithHtml(markdown));
}

export function markdownForNativeParsing(markdown: string): string {
  return markdownWithImageParagraphs(normalizedMarkdown(markdown));
}

export function parseMarkdownDocument(markdown: string): Root {
  return parser.parse(normalizedMarkdown(markdown));
}

export function markdownForNativeRendering(
  markdown: string,
  fileLink: RegExp,
  inlineCodeHrefs?: Set<string>,
): string {
  return transformNativeMarkdown(
    markdownForNativeParsing(markdown),
    fileLink,
    true,
    inlineCodeHrefs,
  );
}

/** Native media slots only cover standalone images; nested file embeds must become links. */
export function markdownWithFileEmbeds(
  markdown: string,
  label: (href: string, standalone: boolean) => string | null,
): { markdown: string; fileHrefs: ReadonlySet<string> } {
  const fileHrefs = new Set<string>();
  if (!markdown.includes("![")) return { markdown, fileHrefs };
  const root = parser.parse(markdown);
  const topLevelBlocks = new Set<MarkdownNode>(root.children);
  const definitions = new Map<string, string>();
  const collect = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, standalone = false, insideLink = false) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href =
        node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase());
      const name = href === undefined ? null : label(href, standalone);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (href !== undefined && name !== null && start !== undefined && end !== undefined) {
        const text = name.replace(/[\\[\]`*_~|&<>]/g, "\\$&");
        const url = href.replace(/[\\&]/g, "\\$&").replace(/</g, "%3C").replace(/>/g, "%3E");
        edits.push({ start, end, content: insideLink ? text : `[${text}](<${url}>)` });
        fileHrefs.add(href);
      }
    }
    if ("children" in node)
      node.children.forEach((child) =>
        visit(
          child,
          node.type === "paragraph" && node.children.length === 1 && topLevelBlocks.has(node),
          insideLink || node.type === "link" || node.type === "linkReference",
        ),
      );
  };
  visit(root);
  return { markdown: applyMarkdownEdits(markdown, edits), fileHrefs };
}

const DIRECTION_MARK = { ltr: "‎", rtl: "‏" } as const;

function proseText(node: MarkdownNode): string {
  if (node.type === "text") return node.value;
  if (node.type === "inlineCode" || node.type === "code") return " ";
  if (!("children" in node)) return "";
  const text = node.children.map(proseText).join("");
  return node.type === "paragraph" || node.type === "heading" || node.type === "tableCell"
    ? ` ${text} `
    : text;
}

// The native renderer scans inline code too when it picks a paragraph's direction.
function renderedText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (!("children" in node)) return "";
  return node.children.map(renderedText).join("");
}

// A mark inside `[label]` or `<url>` would break the reference or autolink.
function firstLeafOffset(node: MarkdownNode): number | undefined {
  if (
    !("children" in node) ||
    node.children.length === 0 ||
    node.type === "link" ||
    node.type === "linkReference"
  ) {
    return node.position?.start.offset;
  }
  return firstLeafOffset(node.children[0]!);
}

/**
 * The native renderer gives each paragraph the direction of its first letter, so an Arabic
 * line that opens with an English name renders left to right. Like the web's
 * `rehypeTextDirection`, each top-level block follows the majority of its words, and a
 * paragraph whose first letter disagrees gets a direction mark that the renderer reads first.
 */
export function markdownWithTextDirection(markdown: string): string {
  // The parser decodes numeric character references, which can spell right-to-left letters.
  if (
    !hasRightToLeftLetter(markdown) &&
    !(markdown.includes("&#") && hasRightToLeftLetter(decodeHtmlEntities(markdown)))
  ) {
    return markdown;
  }
  const edits: MarkdownEdit[] = [];
  for (const block of parser.parse(markdown).children) {
    if (block.type === "code" || block.type === "html") continue;
    const direction = textDirection(proseText(block));
    if (!direction) continue;
    const mark = (node: MarkdownNode) => {
      if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
        const offset = firstLeafOffset(node);
        const first = renderedText(node).match(/\p{L}/u)?.[0];
        if (offset !== undefined && first && textDirection(first) !== direction) {
          edits.push({ start: offset, end: offset, content: DIRECTION_MARK[direction] });
        }
        return;
      }
      if ("children" in node) node.children.forEach(mark);
    };
    mark(block);
  }
  return applyMarkdownEdits(markdown, edits);
}
