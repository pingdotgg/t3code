import type { ReferenceAutolink } from "@t3tools/source-control-core/client/definition";

// GitHub's autolinked references: `#12`, `repo#12` and `owner/repo#12`; a SHA of 7 to 40
// characters, optionally `repo@` or `owner/repo@` qualified; `@user` and `@org/team`.
const REFERENCE =
  /(?<![\w/\\])(?:([\w.-]+\/[\w.-]+|[\w-]+)?#([1-9]\d*)|(?:([\w.-]+\/[\w.-]+|[\w-]+)@)?([a-f\d]{7,40})(?![\w])|@([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d][a-z\d-]*)?))(?![\w])/giu;
const CANDIDATE = /[#@]|\b[a-f\d]{7,40}\b/iu;
const SHORT_SHA_LENGTH = 7;

export function gitHubReferenceAutolinks(
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
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !/^https?:$/u.test(url.protocol)) return [];
  const repository = (qualifier: string | undefined) =>
    qualifier?.includes("/") ? qualifier : qualifier ? `${qualifier}/${repo}` : `${owner}/${repo}`;
  const links: ReferenceAutolink[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const [matched, issueRepo, number, commitRepo, sha, mention] = match;
    if (number) {
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${url.origin}/${repository(issueRepo)}/issues/${number}`,
        kind: "reference",
      });
    } else if (sha) {
      // A run of digits is a number far more often than a SHA.
      if (!/[a-f]/iu.test(sha)) continue;
      links.push({
        index: match.index,
        text: matched,
        label: `${commitRepo ? `${commitRepo}@` : ""}${sha.slice(0, SHORT_SHA_LENGTH)}`,
        url: `${url.origin}/${repository(commitRepo)}/commit/${sha}`,
        kind: "commit",
      });
    } else if (mention) {
      const [organization, team] = mention.split("/");
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${url.origin}/${team ? `orgs/${organization}/teams/${team}` : mention}`,
        kind: "mention",
      });
    }
  }
  return links;
}
