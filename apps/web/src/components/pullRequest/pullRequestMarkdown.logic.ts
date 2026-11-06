import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import type { PluggableList } from "unified";
import { rehypePullRequestMentions } from "./pullRequestMentions";

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
};

const AUTOLINK_IGNORED_TYPES = new Set(["a", "code", "pre", "kbd", "samp", "script", "style"]);

export function rehypePullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
  readonly userMentionsHandled?: boolean;
}) {
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
      // The mention pass already checked authored escapes and username boundaries.
      // Keep host-specific team links, but do not relink rejected user mentions.
      const links = options
        .autolinks(value)
        .filter(
          (link) =>
            !options.userMentionsHandled || link.kind !== "mention" || link.text.includes("/"),
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
    readonly viewer?: string | null | undefined;
  } | null,
): PluggableList {
  if (changeRequest === null) return NO_PLUGINS;
  const repositoryUrl = changeRequestRepositoryUrl(changeRequest);
  if (repositoryUrl === undefined) return NO_PLUGINS;
  const key = `${changeRequest.provider}\u0000${repositoryUrl}\u0000${changeRequest.viewer ?? ""}`;
  let plugins = rehypePlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    const github = changeRequest.provider === "github";
    plugins = [];
    if (github)
      plugins.push([rehypePullRequestMentions, { repositoryUrl, viewer: changeRequest.viewer }]);
    if (autolinks)
      plugins.push([rehypePullRequestAutolinks, { autolinks, userMentionsHandled: github }]);
    rehypePlugins.set(key, plugins);
  }
  return plugins;
}
