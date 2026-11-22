import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-references";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  chatMarkdownImageSource,
  type ChatMarkdownImageProperties,
} from "@t3tools/shared/markdownHast";
import type { Nodes } from "hast";

import {
  splitPullRequestBody as splitBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  markdownReferenceDefinitions,
  wordsHast,
  type MarkdownExtensions,
} from "~/markdown/wordsHast";

export type { PullRequestBodySegment };

export function splitPullRequestBody(body: string): ReadonlyArray<PullRequestBodySegment> {
  return splitBody(body, markdownReferenceDefinitions);
}

const NO_EXTENSIONS: MarkdownExtensions = {};
const markdownExtensions = new Map<string, MarkdownExtensions>();

/**
 * One extension object per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render.
 */
export function pullRequestMarkdownExtensions(
  changeRequest: { readonly provider: string; readonly url: string } | null,
): MarkdownExtensions {
  if (changeRequest === null) return NO_EXTENSIONS;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  if (repositoryUrl === undefined) return NO_EXTENSIONS;
  const key = `${changeRequest.provider}\u0000${repositoryUrl}`;
  let extensions = markdownExtensions.get(key);
  if (extensions === undefined) {
    extensions = {
      changeRequest: {
        repositoryUrl,
        autolinks: changeRequestReferenceAutolinker(changeRequest),
      },
      githubEmoji: changeRequest.provider === "github",
    };
    markdownExtensions.set(key, extensions);
  }
  return extensions;
}

const PREVIEW_MARKDOWN = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: NO_EXTENSIONS,
};
const GITHUB_PREVIEW_MARKDOWN = {
  ...PREVIEW_MARKDOWN,
  extensions: { githubEmoji: true },
};

const PREVIEW_BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function commentPreviewText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "img") {
    return typeof node.properties.alt === "string" ? node.properties.alt : "";
  }
  if (!("children" in node)) return "";
  const text = node.children.map(commentPreviewText).join("");
  return node.type === "element" && PREVIEW_BLOCK_TAGS.has(node.tagName) ? ` ${text} ` : text;
}

export function pullRequestCommentPreview(body: string, provider: string): string {
  const options = provider === "github" ? GITHUB_PREVIEW_MARKDOWN : PREVIEW_MARKDOWN;
  return commentPreviewText(wordsHast(body, options)).replace(/\s+/gu, " ").trim();
}

/** Every image source in the markdown, with each theme variant. */
function markdownImageSources(markdown: string): Array<string> {
  const sources: Array<string> = [];
  const visit = (node: Nodes) => {
    if (node.type === "element" && node.tagName === "img") {
      const properties = node.properties as ChatMarkdownImageProperties;
      const fallback = chatMarkdownImageSource(properties);
      if (fallback) sources.push(fallback.classifiedSrc);
      for (const [theme, variant] of [
        ["dark", properties.dataDarkSrc],
        ["light", properties.dataLightSrc],
      ] as const) {
        if (typeof variant !== "string") continue;
        const source = chatMarkdownImageSource(properties, theme);
        if (source) sources.push(source.classifiedSrc);
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(wordsHast(markdown, PREVIEW_MARKDOWN));
  return sources;
}

// Markdown shows an image only from `![` or a raw `<img>` (or `<image>`, which HTML reads as one),
// so text without either skips the parse, which costs a whole chat markdown pass.
const MAY_HOLD_IMAGE = /!\[|<im/iu;

export function pullRequestAttachments(body: string) {
  const attachments: Array<{ url: string; media: "image" | "video"; caption: string }> = [];
  const seen = new Set<string>();
  const add = (url: string, media: "image" | "video", caption: string) => {
    if (seen.has(url) || !/^https?:\/\//iu.test(url)) return;
    seen.add(url);
    attachments.push({
      url,
      media,
      caption: caption || `${media === "image" ? "Image" : "Video"} ${attachments.length + 1}`,
    });
  };
  const collect = (segments: ReturnType<typeof splitPullRequestBody>) => {
    for (const segment of segments) {
      if (segment.kind === "attachment") {
        if (segment.media !== "unknown") add(segment.url, segment.media, "");
      } else if (segment.kind === "table") {
        for (const cell of segment.rows.flat()) collect(cell.segments);
      } else if (MAY_HOLD_IMAGE.test(segment.text)) {
        for (const url of markdownImageSources(segment.text)) add(url, "image", "");
      }
    }
  };
  collect(splitPullRequestBody(body));
  return attachments;
}
