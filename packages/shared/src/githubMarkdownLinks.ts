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

/** Azure references are rewritten only in prose; code and authored links retain their source. */
export function azureDevOpsMarkdownLinks(
  markdown: string,
  repositoryUrl: string | null,
  identities: Readonly<Record<string, string>> = {},
): string {
  if (!repositoryUrl || !/[#!][1-9]|@<[\da-f]|\b[\da-f]{40}\b/i.test(markdown)) return markdown;
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return markdown;
  }
  if (
    !(url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com")) ||
    !url.pathname.includes("/_git/")
  )
    return markdown;
  const project = `${url.origin}${url.pathname.split("/_git/")[0]}`;
  const repository = `${project}/_git/${url.pathname.split("/_git/")[1]!.split("/")[0]}`;
  const protectedRanges: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode) => {
    if (
      [
        "link",
        "linkReference",
        "image",
        "imageReference",
        "code",
        "inlineCode",
        "definition",
        "html",
      ].includes(node.type)
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        start !== undefined &&
        end !== undefined &&
        !(node.type === "html" && /^<[0-9a-f-]{36}>$/i.test(markdown.slice(start, end)))
      )
        protectedRanges.push({ start, end });
      return;
    }
    let protectedStart: number | undefined;
    let depth = 0;
    for (const child of node.children ?? []) {
      if (child.type === "html") {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const tag = start === undefined || end === undefined ? "" : markdown.slice(start, end);
        for (const match of tag.matchAll(/<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/gi)) {
          if (!match[1] && depth++ === 0) protectedStart = start;
          if (match[1] && --depth === 0 && protectedStart !== undefined && end !== undefined)
            protectedRanges.push({ start: protectedStart, end });
        }
      }
      visit(child);
    }
    if (depth > 0 && protectedStart !== undefined)
      protectedRanges.push({
        start: protectedStart,
        end: node.position?.end.offset ?? markdown.length,
      });
  };
  visit(parser.parse(markdown));
  const pattern =
    /(?<![\w/\\])(?:@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>|([#!])([1-9]\d*)|\b([0-9a-f]{40})\b)/gi;
  const edits = [...markdown.matchAll(pattern)].filter(
    (match) =>
      !protectedRanges.some(
        (range) => match.index < range.end && match.index + match[0].length > range.start,
      ),
  );
  for (let index = edits.length - 1; index >= 0; index--) {
    const match = edits[index]!;
    const [original, identity, pullRequest, reference, commit] = match;
    const name = identity ? (identities[identity.toLowerCase()] ?? identity) : original;
    const label = (identity ? `@${name}` : commit ? commit.slice(0, 7) : name).replace(
      /[\\[\]]/g,
      "\\$&",
    );
    const target = identity
      ? `${project}/_settings/people?userId=${identity}`
      : commit
        ? `${repository}/commit/${commit}`
        : pullRequest === "!"
          ? `${repository}/pullrequest/${reference}`
          : `${project}/_workitems/edit/${reference}`;
    markdown =
      markdown.slice(0, match.index) +
      `[${label}](<${target}>)` +
      markdown.slice(match.index + original.length);
  }
  return markdown;
}
