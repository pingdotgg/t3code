import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-references";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
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
        provider: changeRequest.provider,
        url: changeRequest.url,
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
