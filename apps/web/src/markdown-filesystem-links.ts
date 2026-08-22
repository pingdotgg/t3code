import { toFilesystemLinkUrl } from "./markdown-links";

interface MarkdownAstNode {
  readonly type: string;
  url?: unknown;
  children?: MarkdownAstNode[];
}

/**
 * Rewrite Windows drive link destinations to the `file:` URLs they can survive
 * the rest of the pipeline as.
 *
 * `[open](D:/src/main.ts)` renders as styled but dead text otherwise: with raw
 * HTML parsing on, `rehype-sanitize` reads `D:` as an unknown protocol and
 * removes the href before `urlTransform` ever sees it, and with it off
 * `defaultUrlTransform` returns an empty string for the same reason. Rewriting
 * at the syntax-tree stage covers both, because remark plugins run either way.
 *
 * The renderer still receives a plain path: `rewriteMarkdownFileUriHref` maps
 * the `file:` URL back on the way out, which is the form the resolved file
 * links are keyed by.
 */
export function remarkFilesystemLinkDestinations() {
  return (tree: MarkdownAstNode): void => {
    const visit = (node: MarkdownAstNode): void => {
      // Reference definitions carry a destination too, so `[a][ref]` behaves the
      // same as the inline form.
      if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
        const fileUrl = toFilesystemLinkUrl(node.url);
        if (fileUrl !== null) {
          node.url = fileUrl;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
