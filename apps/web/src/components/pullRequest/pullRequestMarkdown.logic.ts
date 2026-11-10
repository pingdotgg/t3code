import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import type { PluggableList } from "unified";
import { authoredMentionOffsets } from "./pullRequestMentions";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
};

const AUTOLINK_IGNORED_TYPES = new Set(["a", "code", "pre", "kbd", "samp", "script", "style"]);

export function rehypePullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  let source: string | undefined;
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.tagName !== undefined && AUTOLINK_IGNORED_TYPES.has(child.tagName)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const startOffset = child.position?.start.offset;
      const endOffset = child.position?.end.offset;
      const authored =
        source !== undefined && startOffset !== undefined && endOffset !== undefined
          ? source.slice(startOffset, endOffset)
          : undefined;
      const offsets = authored === undefined ? undefined : authoredMentionOffsets(value, authored);
      const links = options
        .autolinks(value)
        .filter(
          (link) =>
            link.kind !== "mention" ||
            (authored !== undefined &&
              offsets?.get(link.index) !== undefined &&
              authored.startsWith(link.text, offsets.get(link.index))),
        );
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "element",
          tagName: "a",
          properties: { href: link.url, dataPullRequestAutolink: link.kind },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    source = typeof file.value === "string" ? file.value : undefined;
    visit(tree);
  };
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
const remarkPlugins = new Map<string, PluggableList>();
const rehypePlugins = new Map<string, PluggableList>();

function changeRequestRepositoryUrl(changeRequest: { readonly url: string }) {
  return sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link.repositoryUrl;
}

/**
 * One plugin list per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render.
 */
export function pullRequestMarkdownPlugins(
  changeRequest: { readonly url: string } | null,
): PluggableList {
  if (changeRequest === null) return NO_PLUGINS;
  const repositoryUrl = changeRequestRepositoryUrl(changeRequest);
  if (repositoryUrl === undefined) return NO_PLUGINS;
  let plugins = remarkPlugins.get(repositoryUrl);
  if (plugins === undefined) {
    plugins = [[remarkChangeRequestMediaUrls, { changeRequestUrl: repositoryUrl }]];
    remarkPlugins.set(repositoryUrl, plugins);
  }
  return plugins;
}

export function pullRequestRehypePlugins(
  changeRequest: {
    readonly provider: string;
    readonly url: string;
  } | null,
): PluggableList {
  if (changeRequest === null) return NO_PLUGINS;
  const repositoryUrl = changeRequestRepositoryUrl(changeRequest);
  if (repositoryUrl === undefined) return NO_PLUGINS;
  const key = `${changeRequest.provider}\u0000${repositoryUrl}\u0000`;
  let plugins = rehypePlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    plugins = [];
    if (autolinks) plugins.push([rehypePullRequestAutolinks, { autolinks }]);
    rehypePlugins.set(key, plugins);
  }
  return plugins;
}
