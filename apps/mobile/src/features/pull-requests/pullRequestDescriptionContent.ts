import type { PullRequestBodySegment } from "@t3tools/client-runtime/pull-request-markdown";
import type { MarkdownNode } from "../../lib/markdownDocument";

export function pullRequestDescriptionContent(
  document: MarkdownNode,
  media: readonly PullRequestBodySegment[] = [],
) {
  const attachments = new Map<
    string,
    { readonly uri: string; readonly caption: string; readonly kind: "image" | "video" | "unknown" }
  >();
  const text: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") {
      if (node.url && /^https?:\/\//i.test(node.url) && !attachments.has(node.url)) {
        attachments.set(node.url, {
          uri: node.url,
          caption: node.alt || node.title || "Image",
          kind: "image",
        });
      }
      return;
    }
    if (node.type === "html") return;
    if ("value" in node) text.push(node.value);
    if ("children" in node) node.children.forEach(visit);
    if (["paragraph", "heading", "listItem", "code"].includes(node.type)) text.push("\n");
    if (node.type === "break") text.push(" ");
  };
  visit(document);
  const collect = (segment: PullRequestBodySegment) => {
    if (segment.kind === "table") {
      segment.rows.flat().forEach((cell) => cell.segments.forEach(collect));
      return;
    }
    if (segment.kind === "attachment" && !attachments.has(segment.url)) {
      const name = new URL(segment.url).pathname.split("/").pop();
      attachments.set(segment.url, {
        uri: segment.url,
        caption: segment.media === "video" ? "Video" : name || "Image",
        kind: segment.media,
      });
    }
  };
  media.forEach(collect);
  return { preview: text.join("").trim(), attachments: [...attachments.values()] };
}
