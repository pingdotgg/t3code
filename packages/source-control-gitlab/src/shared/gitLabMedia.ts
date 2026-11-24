import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

// A host that requires sign-in serves a user's uploaded avatar only to a signed-in request.
const USER_AVATAR_PATH = /^\/uploads\/-\/system\/user\/avatar\/\d+\/([^/]+)$/u;

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const fileName = USER_AVATAR_PATH.exec(url.pathname)?.[1];
  return fileName === undefined
    ? null
    : { fetchUrl: `${url.protocol}//${url.host}${url.pathname}${url.search}`, fileName };
}
