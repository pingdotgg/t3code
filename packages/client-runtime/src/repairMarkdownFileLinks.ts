import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkCodexDirectives } from "./codexMarkdownDirectives.ts";
import { parseMarkdownFileLink } from "./markdownLinks.ts";

const parser = unified().use(remarkParse).use(remarkCodexDirectives).freeze();
const CANDIDATE = /\[[^[\]\r\n]*\]\([ \t]*<([^<>()\r\n]+)\)/g;
const PROTECTED = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "image",
  "linkReference",
  "imageReference",
  "definition",
  "textDirective",
  "leafDirective",
  "containerDirective",
]);

function isEscaped(source: string, offset: number): boolean {
  let backslashes = 0;
  while (offset > 0 && source[--offset] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

/** Closes only complete, unambiguous local-file destinations for assistant rendering. */
export function repairMarkdownFileLinks(markdown: string): string {
  if (!/\]\([ \t]*</.test(markdown)) return markdown;
  const candidates = Array.from(markdown.matchAll(CANDIDATE)).filter((match) => {
    const start = match.index;
    const close = start + match[0].length - 1;
    return (
      !isEscaped(markdown, start) &&
      !(markdown[start - 1] === "!" && !isEscaped(markdown, start - 1)) &&
      !isEscaped(markdown, close) &&
      (close + 1 === markdown.length || /[\s.,;:!?}\]*_~]/.test(markdown[close + 1] ?? "")) &&
      parseMarkdownFileLink(match[1] ?? "") !== null
    );
  });
  if (candidates.length === 0) return markdown;

  const protectedRanges: Array<{ start: number; end: number }> = [];
  interface Node {
    type: string;
    position?:
      | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
      | undefined;
    children?: Node[] | undefined;
  }
  const visit = (node: Node, paragraph?: Node) => {
    const containingParagraph = node.type === "paragraph" ? node : paragraph;
    const sourceStart = node.position?.start.offset;
    const sourceEnd = node.position?.end.offset;
    const unfinishedDirective =
      (node.type === "textDirective" && markdown[sourceEnd ?? -1] === "{") ||
      (node.type === "text" &&
        markdown.slice(sourceStart, sourceEnd).includes("::artifact-template{"));
    if (PROTECTED.has(node.type) || unfinishedDirective) {
      // Inline HTML and unfinished directive attributes can span separate text nodes.
      const protectedNode =
        node.type === "html" || unfinishedDirective ? (containingParagraph ?? node) : node;
      const start = protectedNode.position?.start.offset;
      const end = protectedNode.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end });
      return;
    }
    node.children?.forEach((child) => visit(child, containingParagraph));
  };
  visit(parser.parse(markdown));

  let rendered = "";
  let cursor = 0;
  for (const match of candidates) {
    const start = match.index;
    const end = start + match[0].length;
    if (protectedRanges.some((range) => start < range.end && end > range.start)) continue;
    rendered += markdown.slice(cursor, end - 1) + ">";
    cursor = end - 1;
  }
  return rendered + markdown.slice(cursor);
}
