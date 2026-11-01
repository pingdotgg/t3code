import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { unified } from "unified";

export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
const HTTP_URL = /https?:\/\/\S+/g;

/**
 * `dir="auto"` misreads Arabic prose that opens with an English term.
 * Count words so mixed prose follows its main language; break ties with the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  let rtlWords = 0;
  let ltrWords = 0;
  let first: TextDirection | undefined;
  for (const word of text.split(/\s+/)) {
    const letter = LETTER.exec(word)?.[0];
    if (!letter) continue;
    const direction = RTL_LETTER.test(letter) ? "rtl" : "ltr";
    first ??= direction;
    if (direction === "rtl") rtlWords += 1;
    else ltrWords += 1;
  }
  if (rtlWords === ltrWords) return first;
  return rtlWords > ltrWords ? "rtl" : "ltr";
}

const markdownParser = unified().use(remarkParse).freeze();
const nativeMarkdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

function maskTextRanges(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  replacement = " ",
) {
  let offset = 0;
  const parts: string[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(offset, range.start);
    const end = Math.min(text.length, range.end);
    if (end <= start) continue;
    parts.push(text.slice(offset, start), text.slice(start, end).replace(/[^\r\n]/g, replacement));
    offset = end;
  }
  return parts.join("") + text.slice(offset);
}

/** Native paragraph ranges, using the desktop composer's prose-only word majority. */
export function composerParagraphDirections(
  text: string,
  chips: ReadonlyArray<{ start: number; end: number }> = [],
) {
  // A chip is an atom, not indentation that could turn following prose into a code block.
  const source = maskTextRanges(text, chips, "\ufffc");
  const document = markdownParser.parse(source);
  const code: Array<{ start: number; end: number }> = [];
  const codeBlocks: Array<{ start: number; end: number }> = [];
  const visit = (node: Root | RootContent): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        code.push({ start, end });
        if (node.type === "code") codeBlocks.push({ start, end });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  const urls = Array.from(source.matchAll(HTTP_URL), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const prose = maskTextRanges(source, [...code, ...urls]);
  const groups = document.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return (node.type === "list" || node.type === "blockquote") &&
      start !== undefined &&
      end !== undefined
      ? [{ start, end, direction: textDirection(prose.slice(start, end)) }]
      : [];
  });
  let previous: TextDirection | undefined;
  const paragraphs: Array<{ start: number; end: number; direction: TextDirection }> = [];
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
    const start = line.index;
    const end = start + line[0].length;
    if (start === end && text.length > 0 && !/[\r\n]$/.test(text)) continue;
    if (codeBlocks.some((block) => start < block.end && end > block.start)) {
      paragraphs.push({ start, end, direction: "ltr" });
      continue;
    }
    const group = groups.find((block) => start < block.end && end > block.start);
    const direction =
      (group ? group.direction : textDirection(prose.slice(start, end))) ?? previous;
    paragraphs.push({ start, end, direction: direction ?? "ltr" });
    previous = direction;
  }
  return paragraphs;
}

export function markdownCodeParts(markdown: string) {
  const parts: Array<{ text: string; code: boolean; start: number }> = [];
  let offset = 0;
  const visit = (node: Root | RootContent): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (start > offset) {
        parts.push({ text: markdown.slice(offset, start), code: false, start: offset });
      }
      parts.push({ text: markdown.slice(start, end), code: true, start });
      offset = end;
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(markdownParser.parse(markdown));
  if (offset < markdown.length) {
    parts.push({ text: markdown.slice(offset), code: false, start: offset });
  }
  return parts;
}

function proseDirection(parts: ReadonlyArray<{ text: string; code: boolean }>) {
  const prose = parts
    .filter((part) => !part.code)
    .map((part) => part.text)
    .join(" ");
  return textDirection(prose.replace(HTTP_URL, " "));
}

export function markdownProseDirection(...fields: ReadonlyArray<string>) {
  return proseDirection(fields.flatMap(markdownCodeParts));
}

export function markdownPreview(markdown: string, maxChars: number) {
  let previousSpace = false;
  const normalized = [];
  for (const part of markdownCodeParts(markdown)) {
    let text = part.text.replace(/\s+/g, " ");
    if (previousSpace && text.startsWith(" ")) text = text.slice(1);
    if (text.length > 0) previousSpace = text.endsWith(" ");
    normalized.push({ ...part, text });
  }
  const length = normalized.reduce((total, part) => total + part.text.length, 0);
  const parts = [];
  let rendered = 0;
  for (const part of normalized) {
    if (rendered >= maxChars) break;
    let text = part.text.slice(0, maxChars - rendered);
    rendered += text.length;
    if (rendered === maxChars && length > maxChars) text += "…";
    parts.push({ ...part, text });
  }
  return { parts, direction: proseDirection(parts) };
}

export function markdownWithDirection(markdown: string, direction: TextDirection | undefined) {
  if (!direction) return markdown;
  const offsets: number[] = [];
  const visit = (node: Root | RootContent, parent?: Root | RootContent): void => {
    if (node.type === "paragraph" || node.type === "heading") {
      const child = node.children.length === 1 ? node.children[0] : undefined;
      const media =
        (child?.type === "link" || child?.type === "linkReference") && child.children.length === 1
          ? child.children[0]
          : child;
      if (
        node.type === "paragraph" &&
        (media?.type === "image" || media?.type === "imageReference")
      ) {
        return;
      }
      let offset = node.children[0]?.position?.start.offset;
      if (offset !== undefined) {
        // Keep the native admonition marker at the start of its quote line.
        const alert =
          parent?.type === "blockquote" && parent.children[0] === node
            ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][\t ]*(?:\r?\n[\t ]*(?:>[\t ]*)*|$)/i.exec(
                markdown.slice(offset, node.position?.end.offset),
              )
            : null;
        if (alert) offset += alert[0].length;
        if (offset < (node.position?.end.offset ?? markdown.length)) offsets.push(offset);
      }
    }
    if ("children" in node) node.children.forEach((child) => visit(child, node));
  };
  visit(nativeMarkdownParser.parse(markdown));
  const mark = direction === "rtl" ? "\u200f" : "\u200e";
  for (const offset of offsets.reverse()) {
    markdown = markdown.slice(0, offset) + mark + markdown.slice(offset);
  }
  return markdown;
}
