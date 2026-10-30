import type { Root as HastRoot } from "hast";
import type { Root } from "mdast";
import { isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";

import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { blockTextDirections } from "../components/chat/markdownTextDirection";
import { toChatHast } from "./toHast";

// The protocols CHAT_MARKDOWN_SANITIZE_SCHEMA adds to rehype-sanitize's defaults.
const CHAT_HAST_OPTIONS = {
  hrefProtocols: ["file", "t3-citation", "t3-context", THREAD_LINK_PROTOCOL],
  srcProtocols: ["file", "t3-context"],
  isWindowsDrivePathHref,
};

const addHeadingIds = rehypeHeadingIds();

/**
 * What CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS make of `tree`, built directly; null when the tree
 * needs the HTML parser (raw HTML) and so the rehype plugins.
 */
export function chatRenderHast(tree: Root): HastRoot | null {
  const result = toChatHast(tree, CHAT_HAST_OPTIONS);
  if (!result) return null;
  // Inline code is already isolated left to right; heading ids need headings.
  if (result.hasHeading) addHeadingIds(result.hast);
  blockTextDirections(result.hast);
  return result.hast;
}
