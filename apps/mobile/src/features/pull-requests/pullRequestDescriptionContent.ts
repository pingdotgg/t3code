import type { PullRequestBodySegment } from "@t3tools/client-runtime/pull-request-markdown";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/** Read media from the parsed document so code examples never become attachments. */
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
      if (node.href && /^https?:\/\//i.test(node.href) && !attachments.has(node.href)) {
        attachments.set(node.href, {
          uri: node.href,
          caption: node.alt || node.title || "Image",
          kind: "image",
        });
      }
      return;
    }
    if (node.type === "html_block" || node.type === "html_inline") return;
    if (node.content) text.push(node.content);
    node.children?.forEach(visit);
    if (["paragraph", "heading", "list_item", "code_block"].includes(node.type)) text.push("\n");
    if (node.type === "soft_break" || node.type === "line_break") text.push(" ");
  };
  visit(document);
  for (const segment of media) {
    if (segment.kind === "attachment" && !attachments.has(segment.url)) {
      const name = new URL(segment.url).pathname.split("/").pop();
      attachments.set(segment.url, {
        uri: segment.url,
        caption: segment.media === "video" ? "Video" : name || "Image",
        kind: segment.media,
      });
    }
  }
  return { preview: text.join("").trim(), attachments: [...attachments.values()] };
}
