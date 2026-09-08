import type { PluggableList } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
} from "./codexMarkdownDirectives.ts";
function isWindowsDrivePathHref(href: string): boolean {
  try {
    return /^[A-Za-z]:[\\/]/.test(decodeURIComponent(href));
  } catch {
    return /^[A-Za-z]:[\\/]/.test(href);
  }
}

type MarkdownImageHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

function meaningfulHastChildren(node: MarkdownImageHastNode): MarkdownImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child as { value?: string }).value?.trim() === ""),
  );
}

/**
 * An image that is the only content of its block (optionally wrapped in a
 * link) is almost always a screenshot or figure, so it gets a reserved slot
 * while it loads. Images mixed with text or other images — badge rows, icons
 * in a sentence — stay inline at their natural size, since a placeholder taller
 * than the image would move the page more than the image itself does.
 */
/** Containers whose sole child image reads as a figure rather than part of a sentence. */
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
  // A link, emphasis, or similar inline wrapper around the image still counts
  // as long as nothing else shares the block.
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownImageHastNode) {
  // A raw `<img>` on its own line reaches the root without a paragraph.
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

/** Carries authored image source metadata through the sanitizer to the image renderer. */
function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
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

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    a: [...(defaultSchema.attributes?.a ?? []), "dataPullRequestAutolink"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataLocalSrc",
      "dataMarkdownTitle",
      "dataStandalone",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "t3-citation"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        /^[A-Za-z]:[\\/]/.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}
