import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
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

const NO_AUTOLINK_PLUGINS: PluggableList = [];
const autolinkPlugins = new Map<string, PluggableList>();

/**
 * One plugin list per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render.
 */
export function pullRequestRehypePlugins(
  changeRequest: {
    readonly provider: string;
    readonly url: string;
    readonly viewer?: string | null | undefined;
  } | null,
): PluggableList {
  if (changeRequest === null) return NO_AUTOLINK_PLUGINS;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  if (repositoryUrl === undefined) return NO_AUTOLINK_PLUGINS;
  const key = `rehype\u0000${changeRequest.provider}\u0000${repositoryUrl}\u0000${changeRequest.viewer ?? ""}`;
  let plugins = autolinkPlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    const github = changeRequest.provider === "github";
    plugins = [];
    if (github)
      plugins.push([rehypePullRequestMentions, { repositoryUrl, viewer: changeRequest.viewer }]);
    if (autolinks)
      plugins.push([rehypePullRequestAutolinks, { autolinks, userMentionsHandled: github }]);
    autolinkPlugins.set(key, plugins);
  }
  return plugins;
}
