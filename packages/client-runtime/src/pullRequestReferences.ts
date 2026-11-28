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
