import remarkParse from "remark-parse";
import { unified, type Plugin } from "unified";

import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

const previewParser = unified()
  .use(remarkParse)
  .use(remarkGithubAlerts as Plugin)
  .freeze();

/** A single-line preview that preserves literal characters in resolved mention names. */
export function pullRequestMarkdownPreview(body: string) {
  const text = (node: MarkdownNode & { alt?: string | null }): string => {
    if (node.type === "break") return " ";
    if (node.type === "html") {
      return /^<br(?:\s|\/?>)/iu.test(node.value ?? "") ? " " : "";
    }
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    if (node.value !== undefined) return node.value;
    const separator = ["root", "list", "listItem", "blockquote"].includes(node.type) ? " " : "";
    return node.children?.map(text).join(separator) ?? "";
  };
  return text(previewParser.runSync(previewParser.parse(body)))
    .replace(/\s+/gu, " ")
    .trim();
}

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

const AUTOLINK_CANDIDATE_PATTERN = /#[1-9]\d*|[0-9a-f]{40}/giu;
const AUTOLINK_WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const AUTOLINK_COMMIT_PREFIX_PATTERN = /[\s([{]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

/** GitHub-style same-repository references for pull request prose, never code or authored links. */
export function remarkPullRequestAutolinks(options: { readonly repositoryUrl: string }) {
  const repositoryUrl = options.repositoryUrl.replace(/\/+$/u, "");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      AUTOLINK_CANDIDATE_PATTERN,
      (matched: string, match: TextMatch) => {
        const reference = matched.startsWith("#");
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined &&
            (reference
              ? AUTOLINK_WORD_CHARACTER_PATTERN.test(before)
              : !AUTOLINK_COMMIT_PREFIX_PATTERN.test(before))) ||
          (after !== undefined && AUTOLINK_WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        return {
          type: "link",
          url: reference
            ? `${repositoryUrl}/issues/${matched.slice(1)}`
            : `${repositoryUrl}/commit/${matched}`,
          data: {
            hProperties: {
              dataPullRequestAutolink: reference ? "reference" : "commit",
            },
          },
          children: [{ type: "text", value: reference ? matched : matched.slice(0, 7) }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}
