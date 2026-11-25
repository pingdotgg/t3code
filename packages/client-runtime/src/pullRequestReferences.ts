import { sourceControlClients, type ReferenceAutolink } from "./sourceControlClients.ts";

/** The repository of a change request's or an issue's URL on `provider`'s host. */
export function referenceRepositoryUrl(provider: string, url: string): string | undefined {
  const changeRequest = sourceControlClients.parseChangeRequestUrl(url);
  if (changeRequest !== null) return changeRequest.link.repositoryUrl;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // The provider is the issue's own tracker, so its host is known even when its name is not.
  const issue = sourceControlClients.find(provider)?.parseIssueUrl?.(parsed, true);
  return issue == null ? undefined : `${parsed.origin}/${issue.scope}`;
}

/**
 * Finds the references the change request's or issue's host links in plain text, resolved against
 * its repository. Null when the host links none.
 */
export function changeRequestReferenceAutolinker(
  changeRequest: { readonly provider: string; readonly url: string } | null | undefined,
): ((text: string) => ReadonlyArray<ReferenceAutolink>) | null {
  if (!changeRequest) return null;
  const find = sourceControlClients.get(changeRequest.provider).referenceAutolinks;
  const repositoryUrl = referenceRepositoryUrl(changeRequest.provider, changeRequest.url);
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
