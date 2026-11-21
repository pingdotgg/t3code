import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse);

function readableText(node: Nodes): string {
  switch (node.type) {
    case "code":
    case "html":
    case "image":
    case "imageReference":
    case "definition":
      return "";
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    default:
      return "children" in node
        ? node.children
            .map(readableText)
            .join(
              node.type === "root" ||
                node.type === "list" ||
                node.type === "listItem" ||
                node.type === "blockquote"
                ? "\n\n"
                : "",
            )
        : "";
  }
}

export function speechTextChunks(markdown: string): ReadonlyArray<string> {
  const text = readableText(parser.parse(markdown)).trim();
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let remaining = paragraph.trim();
    while (remaining.length > 1800) {
      let end = remaining.lastIndexOf(" ", 1800);
      if (end < 900) end = 1800;
      const code = remaining.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      chunks.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}
