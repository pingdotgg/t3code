import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownImageSources,
} from "@t3tools/shared/markdownPipeline";
import type { Nodes } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";
import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: unknown;
};

const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

export function remarkPullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (AUTOLINK_IGNORED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.autolinks(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          data: { hProperties: { dataPullRequestAutolink: link.kind } },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}

function remarkChangeRequestMediaUrls(options: { readonly changeRequestUrl: string }) {
  const visit = (node: MarkdownNode): void => {
    if ((node.type === "image" || node.type === "definition") && node.url !== undefined) {
      node.url = resolveChangeRequestMediaUrl(node.url, options.changeRequestUrl);
    }
    node.children?.forEach(visit);
  };
  return (tree: MarkdownNode) => visit(tree);
}

const NO_PLUGINS: PluggableList = [];
const markdownPlugins = new Map<string, PluggableList>();

/**
 * One plugin list per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render.
 */
export function pullRequestMarkdownPlugins(
  changeRequest: { readonly provider: string; readonly url: string } | null,
): PluggableList {
  if (changeRequest === null) return NO_PLUGINS;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  if (repositoryUrl === undefined) return NO_PLUGINS;
  const key = `${changeRequest.provider}\u0000${repositoryUrl}`;
  let plugins = markdownPlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    plugins = [[remarkChangeRequestMediaUrls, { changeRequestUrl: repositoryUrl }]];
    if (autolinks) plugins.push([remarkPullRequestAutolinks, { autolinks }]);
    markdownPlugins.set(key, plugins);
  }
  return plugins;
}

const commentPreviewProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
  .freeze();

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

export function pullRequestCommentPreview(body: string): string {
  const tree = commentPreviewProcessor.runSync(commentPreviewProcessor.parse(body), body);
  return commentPreviewText(tree).replace(/\s+/gu, " ").trim();
}

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
      } else {
        for (const url of chatMarkdownImageSources(segment.text)) add(url, "image", "");
      }
    }
  };
  collect(splitPullRequestBody(body));
  return attachments;
}
