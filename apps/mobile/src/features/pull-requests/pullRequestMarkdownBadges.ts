import {
  markdownWithHtml,
  parseMarkdownDocument,
  type MarkdownNode,
} from "../../lib/markdownDocument";
import { isBotBadgeImage } from "./botBadgeImages";

/** Leading badge images otherwise get the native renderer's 200pt block-image frame. */
export function inlinePullRequestBadges(source: string): string {
  if (!source.includes("![") && !/<img\b/i.test(source)) return source;
  const markdown = markdownWithHtml(source);
  const document = parseMarkdownDocument(markdown);
  const definitions = new Map(
    document.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node.url] as const] : [],
    ),
  );
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href = node.type === "image" ? node.url : definitions.get(node.identifier);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (href && isBotBadgeImage(href) && start !== undefined && end !== undefined) {
        const label = node.alt?.trim().replace(/\s+badge$/i, "") || "Status badge";
        edits.push({ start, end, text: label.replace(/[\\`*_[\]<>]/g, "\\$&") });
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(document);
  return edits.reduceRight(
    (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end),
    markdown,
  );
}
