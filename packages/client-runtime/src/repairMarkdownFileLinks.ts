import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseMarkdownFileLink } from "./markdownLinks.ts";

const parser = unified().use(remarkParse).freeze();
type MarkdownNode = ReturnType<typeof parser.parse>["children"][number];

// ponytail: leave parentheses in malformed paths alone; use a tokenizer if those need repair.
const UNCLOSED_FILE_LINK = /\[[^[\]\\\r\n]*\]\([ \t]*<([^<>()[\]\r\n"']+)\)/g;

export function repairMarkdownFileLinks(markdown: string): string {
  if (!markdown.includes("](")) return markdown;

  function isEscaped(index: number): boolean {
    let start = index;
    while (markdown[start - 1] === "\\") start -= 1;
    return (index - start) % 2 === 1;
  }

  const matches = Array.from(markdown.matchAll(UNCLOSED_FILE_LINK)).filter((match) => {
    const previous = markdown[match.index - 1];
    return (
      !isEscaped(match.index) &&
      (previous !== "!" || isEscaped(match.index - 1)) &&
      parseMarkdownFileLink(match[1] ?? "")
    );
  });
  if (matches.length === 0) return markdown;

  const protectedRanges: Array<{ start: number; end: number }> = [];
  function visit(node: MarkdownNode): void {
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html" ||
      node.type === "link" ||
      node.type === "linkReference" ||
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "definition"
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  }
  parser.parse(markdown).children.forEach(visit);

  const parts: string[] = [];
  let cursor = 0;
  let rangeIndex = 0;
  for (const match of matches) {
    const end = match.index + match[0].length;
    while ((protectedRanges[rangeIndex]?.end ?? Infinity) <= match.index) {
      rangeIndex += 1;
    }
    if ((protectedRanges[rangeIndex]?.start ?? Infinity) < end) continue;
    parts.push(markdown.slice(cursor, end - 1), ">");
    cursor = end - 1;
  }
  parts.push(markdown.slice(cursor));
  return parts.join("");
}
