import { sourceControlClients, type ReferenceAutolink } from "./sourceControlClients.ts";

export function referenceRepositoryUrl(
  subject: { readonly provider: string; readonly url: string } | null | undefined,
): string | undefined {
  if (!subject) return undefined;
  const changeRequestRepo = sourceControlClients.parseChangeRequestUrl(subject.url)?.link
    .repositoryUrl;
  if (changeRequestRepo !== undefined) return changeRequestRepo;
  const client = sourceControlClients.find(subject.provider);
  if (client === undefined) return undefined;
  const issue = sourceControlClients.parseIssueUrl(subject.url, client.kind);
  if (issue === null) return undefined;
  try {
    const parsed = new URL(subject.url);
    const prefix = `/${issue.link.scope}`;
    const repoPath = parsed.pathname.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
      ? parsed.pathname.slice(0, prefix.length)
      : prefix;
    return `${parsed.origin}${repoPath}`;
  } catch {
    return undefined;
  }
}

/**
 * Finds the references the change request or issue host links in plain text, resolved against its
 * repository. Null when the host links none.
 */
export function changeRequestReferenceAutolinker(
  changeRequest: { readonly provider: string; readonly url: string } | null | undefined,
): ((text: string) => ReadonlyArray<ReferenceAutolink>) | null {
  if (!changeRequest) return null;
  const find = sourceControlClients.find(changeRequest.provider)?.referenceAutolinks;
  const repositoryUrl = referenceRepositoryUrl(changeRequest);
  return find === undefined || repositoryUrl === undefined
    ? null
    : (text) => find(text, repositoryUrl);
}

/**
 * Forges link uploads root-relative, as GitCafe's `/api/attachments/<id>`. In a change request
 * body that always means the forge's origin, never a path on the machine rendering it.
 */
export function resolveChangeRequestMediaUrl(url: string, changeRequestUrl: string): string {
  if (!/^\/(?![/\\])/u.test(url)) return url;
  try {
    return new URL(url, changeRequestUrl).href;
  } catch {
    return url;
  }
}
