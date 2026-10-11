import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/** Read media from the parsed document so code examples never become attachments. */
export function pullRequestDescriptionContent(document: MarkdownNode) {
  const attachments = new Map<string, { readonly uri: string; readonly caption: string }>();
  const text: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") {
      if (node.href && /^https?:\/\//i.test(node.href) && !attachments.has(node.href)) {
        attachments.set(node.href, { uri: node.href, caption: node.alt || node.title || "Image" });
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
  return { preview: text.join("").trim(), attachments: [...attachments.values()] };
}
