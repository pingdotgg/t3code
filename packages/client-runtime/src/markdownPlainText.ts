import remarkParse from "remark-parse";
import { unified } from "unified";

interface MarkdownNode {
  type: string;
  value?: string | undefined;
  alt?: string | null | undefined;
  ordered?: boolean | null | undefined;
  start?: number | null | undefined;
  children?: MarkdownNode[] | undefined;
}

const parser = unified().use(remarkParse);

/** Render message text without Markdown syntax, keeping paragraphs and lists. */
export function markdownPlainText(markdown: string): string {
  function render(node: MarkdownNode): string {
    const children = node.children ?? [];
    switch (node.type) {
      case "html":
      case "definition":
      case "thematicBreak":
        return "";
      case "image":
      case "imageReference":
        return node.alt ?? "";
      case "break":
        return "\n";
      case "list":
        return children
          .map(
            (child, index) =>
              `${node.ordered ? `${(node.start ?? 1) + index}.` : "•"} ${render(child)}`,
          )
          .join("\n");
      case "root":
      case "blockquote":
      case "listItem":
        return children.map(render).filter(Boolean).join("\n\n");
      default:
        return node.value ?? children.map(render).join("");
    }
  }
  return render(parser.parse(markdown)).trim();
}
