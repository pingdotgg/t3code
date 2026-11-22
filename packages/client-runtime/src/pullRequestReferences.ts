import { sourceControlClients, type ReferenceAutolink } from "./sourceControlClients.ts";

/**
 * Finds the references the change request's host links in plain text, resolved against the change
 * request's repository. Null when the host links none.
 */
export function changeRequestReferenceAutolinker(
  changeRequest: { readonly provider: string; readonly url: string } | null | undefined,
): ((text: string) => ReadonlyArray<ReferenceAutolink>) | null {
  if (!changeRequest) return null;
  const find = sourceControlClients.get(changeRequest.provider).referenceAutolinks;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  return find === undefined || repositoryUrl === undefined
    ? null
    : (text) => find(text, repositoryUrl);
}

/**
 * Forges link uploads root-relative, as GitCafe's `/api/attachments/<id>`. In a change request
 * body that always means the forge, never a path on the machine rendering it: the repository for
 * a host that says so, as GitLab's `/uploads/<secret>/<name>`, otherwise its origin.
 */
export function resolveChangeRequestMediaUrl(
  url: string,
  changeRequest: { readonly provider: string; readonly url: string },
): string {
  if (!/^\/(?![/\\])/u.test(url)) return url;
  const repositoryUrl = sourceControlClients
    .find(changeRequest.provider)
    ?.isRepositoryRelativePath?.(url)
    ? sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link.repositoryUrl
    : undefined;
  try {
    return repositoryUrl === undefined
      ? new URL(url, changeRequest.url).href
      : `${repositoryUrl.replace(/\/+$/u, "")}${url}`;
  } catch {
    return url;
  }
}
