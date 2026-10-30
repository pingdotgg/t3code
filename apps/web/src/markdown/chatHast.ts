import type { Element, Root as HastRoot } from "hast";
import type { Root } from "mdast";
import { isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";
import {
  rehypePreserveBareAnchorPlaceholders,
  sanitizeChatHast,
} from "@t3tools/shared/markdownPipeline";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";

import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { blockTextDirections, rehypeTextDirection } from "../components/chat/markdownTextDirection";
import { assembleRawHtml } from "./rawHtml";
import { markStandaloneImages, toChatHast } from "./toHast";

// The protocols CHAT_MARKDOWN_SANITIZE_SCHEMA adds to rehype-sanitize's defaults.
const CHAT_HAST_OPTIONS = {
  hrefProtocols: ["file", "t3-citation", "t3-context", THREAD_LINK_PROTOCOL],
  srcProtocols: ["file", "t3-context"],
  isWindowsDrivePathHref,
};

const addHeadingIds = rehypeHeadingIds();
const addTextDirection = rehypeTextDirection();
const preserveBareAnchors = rehypePreserveBareAnchorPlaceholders();

// rehypePreserveImageSourceMeta, for images the raw HTML made.
function imageSourceMeta(node: HastRoot | Element) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "img") {
      const { src, title } = child.properties;
      if (typeof src === "string" && isWindowsDrivePathHref(src))
        child.properties.dataLocalSrc = src;
      if (typeof title === "string") child.properties.dataMarkdownTitle = title;
    }
    imageSourceMeta(child);
  }
}

function hasRawNode(node: HastRoot | Element): boolean {
  return (node.children as Array<{ type: string }>).some(
    (child) => child.type === "raw" || (child.type === "element" && hasRawNode(child as Element)),
  );
}

const RAW_HOOKS = {
  beforeSanitize: (tree: HastRoot) => {
    imageSourceMeta(tree);
    markStandaloneImages(tree);
  },
  sanitize: (tree: HastRoot) => sanitizeChatHast(tree as never) as unknown as HastRoot,
};

/**
 * What CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS make of `tree`, built directly; null when the tree
 * needs the HTML parser, and so the rehype plugins.
 */
export function chatRenderHast(tree: Root): HastRoot | null {
  const result = toChatHast(tree, CHAT_HAST_OPTIONS);
  if (!result) return null;
  // Bare `<a>` placeholders become text; without other raw HTML no HTML parser runs.
  if (result.hasRaw) preserveBareAnchors(result.hast as never);
  if (!result.hasRaw || !hasRawNode(result.hast)) {
    markStandaloneImages(result.hast);
    // Inline code is already isolated left to right; heading ids need headings.
    if (result.hasHeading) addHeadingIds(result.hast);
    blockTextDirections(result.hast);
    return result.hast;
  }
  const hast = assembleRawHtml(result.hast, RAW_HOOKS);
  if (!hast) return null;
  addHeadingIds(hast);
  addTextDirection(hast);
  return hast;
}
