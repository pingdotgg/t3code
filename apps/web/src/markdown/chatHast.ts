import type { Element, Root as HastRoot } from "hast";
import type { Root } from "mdast";
import { LOCAL_FILE_LINK_SCHEMES } from "@t3tools/contracts";
import { isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";
import {
  normalizeLocalEditorHref,
  rehypePreserveBareAnchorPlaceholders,
  rehypeNormalizeLocalEditorLinks,
  rehypePreserveImageSourceMeta,
  sanitizeChatHast,
} from "@t3tools/shared/markdownPipeline";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";

import { rehypeChipPunctuation } from "../components/chat/markdownChipPunctuation";
import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { blockTextDirections, rehypeTextDirection } from "../components/chat/markdownTextDirection";
import { assembleRawHtml } from "./rawHtml";
import { markStandaloneImages, toChatHast } from "./toHast";

// The protocols CHAT_MARKDOWN_SANITIZE_SCHEMA adds to rehype-sanitize's defaults.
const CHAT_HAST_OPTIONS = {
  hrefProtocols: [
    "file",
    "t3-citation",
    "t3-context",
    THREAD_LINK_PROTOCOL,
    ...LOCAL_FILE_LINK_SCHEMES,
  ],
  normalizeHref: normalizeLocalEditorHref,
  srcProtocols: ["file", "t3-context"],
  isWindowsDrivePathHref,
};

const addHeadingIds = rehypeHeadingIds();
const addTextDirection = rehypeTextDirection();
const preserveBareAnchors = rehypePreserveBareAnchorPlaceholders();
const preserveImageSourceMeta = rehypePreserveImageSourceMeta();
const normalizeLocalEditorLinks = rehypeNormalizeLocalEditorLinks();
const groupChipPunctuation = rehypeChipPunctuation();

function hasRawNode(node: HastRoot | Element): boolean {
  return (node.children as Array<{ type: string }>).some(
    (child) => child.type === "raw" || (child.type === "element" && hasRawNode(child as Element)),
  );
}

const RAW_HOOKS = {
  beforeSanitize: (tree: HastRoot) => {
    preserveImageSourceMeta(tree as never);
    normalizeLocalEditorLinks(tree as never);
  },
  sanitize: (tree: HastRoot) => sanitizeChatHast(tree as never) as unknown as HastRoot,
};

/**
 * What ChatMarkdown's render rehype plugins make of `tree`, built directly; null when the tree
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
    groupChipPunctuation(result.hast as never);
    return result.hast;
  }
  const assembled = assembleRawHtml(result.hast, RAW_HOOKS);
  if (!assembled) return null;
  const { tree: hast, seen } = assembled;
  if (result.hasHeading || seen.heading) addHeadingIds(hast);
  // Markdown code is isolated as it is built; only code from raw HTML still needs it.
  if (seen.code) addTextDirection(hast);
  else blockTextDirections(hast);
  groupChipPunctuation(hast as never);
  return hast;
}
