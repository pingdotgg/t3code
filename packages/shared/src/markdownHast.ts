import { isLocalEditorFileUrl, LOCAL_FILE_LINK_SCHEMES } from "@t3tools/contracts";
import type { Root } from "hast";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";

import { CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES } from "./codexArtifactTemplates.ts";
import { isWindowsDrivePathHref, normalizeMarkdownLinkDestination } from "./markdownLinks.ts";
import { THREAD_LINK_PROTOCOL } from "./threadLinks.ts";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

function meaningfulHastChildren(node: MarkdownImageHastNode): MarkdownImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child as { value?: string }).value?.trim() === ""),
  );
}

const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

function soleImageDescendant(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined {
  const children = meaningfulHastChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownImageHastNode) {
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

const COLOR_SCHEME_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;

/**
 * The renderer resolves an `<img>`'s `src` (workspace files, host media) but never a `<source>`'s
 * `srcset`, which would load unresolved whenever its media matched. A color-scheme source moves
 * onto the `<img>` for the renderer to pick by theme; every source is then dropped.
 */
function moveColorSchemeSourcesToImage(picture: MarkdownImageHastNode) {
  if (!picture.children) return;
  const image = picture.children.find((child) => child.tagName === "img");
  for (const source of picture.children) {
    if (source.tagName !== "source" || !image) continue;
    const media = source.properties?.media;
    const scheme = typeof media === "string" ? COLOR_SCHEME_MEDIA.exec(media)?.[1] : undefined;
    const srcSet = source.properties?.srcSet;
    const candidate = Array.isArray(srcSet) ? srcSet[0] : srcSet;
    // A candidate's URL runs to the first space (a descriptor such as `2x` may follow).
    const url =
      typeof candidate === "string" ? candidate.trim().split(/\s/, 1)[0]?.replace(/,+$/, "") : "";
    const key = scheme?.toLowerCase() === "dark" ? "dataDarkSrc" : "dataLightSrc";
    // As in a browser, the first source that matches a scheme is the one shown.
    if (scheme && url && image.properties?.[key] === undefined) {
      // The sanitizer reads a drive letter as a protocol; as a file URL it resolves to the same path.
      const value = isWindowsDrivePathHref(url) ? `file:///${url.replaceAll("\\", "/")}` : url;
      image.properties = { ...image.properties, [key]: value };
    }
  }
  picture.children = picture.children.filter((child) => child.tagName !== "source");
}

export function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "picture") {
        moveColorSchemeSourcesToImage(node);
      }
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    markStandaloneImages(tree);
  };
}

const IMAGE_SRC_PROTOCOLS = [...(defaultSchema.protocols?.src ?? []), "file", "t3-context"];

// The sanitizer compares schemes case-sensitively, so lowercase accepted editor links first.
function normalizeLocalEditorHref(href: string): string {
  try {
    const url = new URL(href);
    return isLocalEditorFileUrl(url) ? url.href : href;
  } catch {
    // Not an absolute URL; the sanitizer decides.
    return href;
  }
}

export function rehypeNormalizeLocalEditorLinks() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const href = node.properties?.href;
      if (node.type === "element" && node.tagName === "a" && typeof href === "string") {
        const normalized = normalizeLocalEditorHref(href);
        if (normalized !== href) node.properties = { ...node.properties, href: normalized };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

export const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // Fence languages plus the two math classes the web chat's math plugin emits.
    code: [
      ["className", /^language-./, "math-inline", "math-display"],
      "dataCodeMeta",
      "dataInlineCode",
    ],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    // Spaces typed at the start of a user's line (keepLeadingWhitespace).
    span: [...(defaultSchema.attributes?.span ?? []), "dataLeadingWhitespace"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    a: [...(defaultSchema.attributes?.a ?? []), "dataPullRequestAutolink"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataDarkSrc",
      "dataLightSrc",
      "dataLocalSrc",
      "dataMarkdownTitle",
      "dataStandalone",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "file",
      "t3-citation",
      "t3-context",
      THREAD_LINK_PROTOCOL,
      // Scheme only: the renderer's URL transform checks the rest of the link shape.
      ...LOCAL_FILE_LINK_SCHEMES,
    ],
    src: IMAGE_SRC_PROTOCOLS,
    dataDarkSrc: IMAGE_SRC_PROTOCOLS,
    dataLightSrc: IMAGE_SRC_PROTOCOLS,
  },
} satisfies Schema;

/** Sanitizes one tree with the chat's schema, as the last rehype plugin does. */
export const sanitizeChatHast = (tree: Root): Root =>
  sanitize(tree, CHAT_MARKDOWN_SANITIZE_SCHEMA) as Root;

export type ChatMarkdownImageProperties = {
  readonly src?: unknown;
  readonly dataLocalSrc?: unknown;
  readonly dataDarkSrc?: unknown;
  readonly dataLightSrc?: unknown;
};

/** Keep the authored path for file links and normalize Windows separators for classification. */
export function chatMarkdownImageSource(
  properties?: ChatMarkdownImageProperties,
  theme?: "dark" | "light",
) {
  const themeSrc =
    theme === undefined
      ? undefined
      : properties?.[theme === "dark" ? "dataDarkSrc" : "dataLightSrc"];
  const localSrc = typeof themeSrc === "string" ? undefined : properties?.dataLocalSrc;
  const source =
    typeof themeSrc === "string"
      ? themeSrc
      : typeof localSrc === "string"
        ? localSrc
        : properties?.src;
  if (typeof source !== "string") return null;
  const authoredSrc = normalizeMarkdownLinkDestination(source);
  return {
    authoredSrc,
    classifiedSrc: typeof localSrc === "string" ? authoredSrc.replaceAll("\\", "/") : authoredSrc,
  };
}
