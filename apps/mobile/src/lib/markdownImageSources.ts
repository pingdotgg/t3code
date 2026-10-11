import { nativeMarkdownWithHtml } from "@t3tools/mobile-markdown-text/markdown";
import { parseMarkdownWithOptions, type MarkdownNode } from "react-native-nitro-markdown/headless";

export function markdownImageSources(markdown: string): string[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const sources = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" && node.href) sources.add(node.href);
    node.children?.forEach(visit);
  };
  visit(
    nativeMarkdownWithHtml(
      parseMarkdownWithOptions(markdown, { gfm: true, html: true, math: false }),
      (text) => parseMarkdownWithOptions(text, { gfm: true, html: false, math: false }),
    ),
  );
  return [...sources];
}
