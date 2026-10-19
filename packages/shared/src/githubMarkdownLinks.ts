import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  readonly type: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

const parser = unified().use(remarkParse).use(remarkGfm);
const reference =
  /(?<![\w/\\])(?:([\w.-]+\/[\w.-]+|[\w-]+)?#([1-9]\d*)|(?:([\w.-]+\/[\w.-]+|[\w-]+)@)?([a-f\d]{7,40})(?![\w])|@([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d][a-z\d-]*)?))(?![\w])/gi;

export function githubMarkdownLinks(markdown: string, pullRequestUrl: string | null): string {
  if (!pullRequestUrl || !/[#@]|\b[a-f\d]{7,40}\b/i.test(markdown)) return markdown;
  let url: URL;
  try {
    url = new URL(pullRequestUrl);
  } catch {
    return markdown;
  }
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !/^https?:$/.test(url.protocol)) return markdown;
  const edits: { start: number; end: number; value: string }[] = [];
  const repository = (qualifier: string | undefined) =>
    qualifier?.includes("/") ? qualifier : qualifier ? `${qualifier}/${repo}` : `${owner}/${repo}`;
  const visit = (node: MarkdownNode) => {
    if (
      [
        "link",
        "linkReference",
        "image",
        "imageReference",
        "code",
        "inlineCode",
        "html",
        "definition",
      ].includes(node.type)
    )
      return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const source = markdown.slice(start, end);
      for (const match of source.matchAll(reference)) {
        const [label, issueRepo, number, commitRepo, sha, mention] = match;
        if (sha && !/[a-f]/i.test(sha)) continue;
        const path = number
          ? `${repository(issueRepo)}/issues/${number}`
          : sha
            ? `${repository(commitRepo)}/commit/${sha}`
            : mention?.includes("/")
              ? `orgs/${mention.split("/")[0]}/teams/${mention.split("/")[1]}`
              : mention;
        if (!path) continue;
        edits.push({
          start: start + match.index,
          end: start + match.index + label.length,
          value: `[${label}](${url.origin}/${path})`,
        });
      }
    } else if ("children" in node) {
      let protectedHtmlDepth = 0;
      for (const child of node.children ?? []) {
        if (child.type === "html") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const tag = start === undefined || end === undefined ? "" : markdown.slice(start, end);
          for (const match of tag.matchAll(/<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/gi)) {
            protectedHtmlDepth = Math.max(0, protectedHtmlDepth + (match[1] ? -1 : 1));
          }
        } else if (protectedHtmlDepth === 0) visit(child);
      }
    }
  };
  visit(parser.parse(markdown));
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    markdown = markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  }
  return markdown;
}
