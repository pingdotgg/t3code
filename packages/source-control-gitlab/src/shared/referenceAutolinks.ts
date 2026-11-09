import type { ReferenceAutolink } from "@t3tools/source-control-core/shared/definition";

// GitLab's autolinked references: `#12` issues and `!12` merge requests, qualified by
// `project` (same namespace) or a full `group/sub/project` path; `GL-12` and `[issue:12]`
// (or `[issue:project/12]`) issues; a SHA of 7 to 40 characters,
// optionally qualified the same way with `@`; `@user` and `@group/subgroup`.
const PROJECT = String.raw`[\w.-]+(?:\/[\w.-]+)*`;
const REFERENCE = new RegExp(
  String.raw`(?<![\w./\\-])(?:(${PROJECT})?([#!])([1-9]\d*)|(?:(${PROJECT})@)?([a-f\d]{7,40})(?![\w])|@([\w](?:[\w.-]*[\w])?(?:\/[\w](?:[\w.-]*[\w])?)*)|GL-([1-9]\d*)|\[issue:(?:(${PROJECT})\/)?([1-9]\d*)\])(?![\w])`,
  "giu",
);
const CANDIDATE = /[#!@]|\bGL-\d|\[issue:|\b[a-f\d]{7,40}\b/iu;
const SHORT_SHA_LENGTH = 7;
const ROUTE = { "#": "issues", "!": "merge_requests" } as const;

export function gitLabReferenceAutolinks(
  text: string,
  repositoryUrl: string,
): ReadonlyArray<ReferenceAutolink> {
  if (!CANDIDATE.test(text)) return [];
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return [];
  }
  const path = url.pathname.split("/").filter(Boolean);
  if (path.length < 2 || !/^https?:$/u.test(url.protocol)) return [];
  const namespace = path.slice(0, -1).join("/");
  const project = (qualifier: string | undefined) =>
    qualifier?.includes("/") ? qualifier : qualifier ? `${namespace}/${qualifier}` : path.join("/");
  const links: ReferenceAutolink[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const [
      matched,
      referenceProject,
      sigil,
      number,
      commitProject,
      sha,
      mention,
      prefixedIssue,
      bracketProject,
      bracketIssue,
    ] = match;
    if (number && (sigil === "#" || sigil === "!")) {
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${url.origin}/${project(referenceProject)}/-/${ROUTE[sigil]}/${number}`,
        kind: "reference",
      });
    } else if (bracketIssue || (prefixedIssue && matched.startsWith("GL-"))) {
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${url.origin}/${project(bracketProject)}/-/issues/${bracketIssue ?? prefixedIssue}`,
        kind: "reference",
      });
    } else if (sha) {
      // A run of digits is a number far more often than a SHA.
      if (!/[a-f]/iu.test(sha)) continue;
      links.push({
        index: match.index,
        text: matched,
        label: `${commitProject ? `${commitProject}@` : ""}${sha.slice(0, SHORT_SHA_LENGTH)}`,
        url: `${url.origin}/${project(commitProject)}/-/commit/${sha}`,
        kind: "commit",
      });
    } else if (mention && mention.toLowerCase() !== "all") {
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${url.origin}/${mention}`,
        kind: "mention",
      });
    }
  }
  return links;
}
