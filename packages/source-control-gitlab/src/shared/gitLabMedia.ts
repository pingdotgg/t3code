import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

// A phone or a browser off the GitLab network cannot load this URL; the T3 server can.
const USER_AVATAR_PATH = /^\/uploads\/-\/system\/user\/avatar\/\d+\/([^/]+)$/u;

export const isGitLabHostname = (hostname: string) =>
  hostname === "gitlab.com" || hostname.split(".").includes("gitlab");

export function gitLabMediaUrl(url: URL, host?: string): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (host !== undefined && url.host.toLowerCase() !== host.toLowerCase()) return null;
  const fileName = USER_AVATAR_PATH.exec(url.pathname)?.[1];
  return fileName === undefined
    ? null
    : { fetchUrl: `${url.protocol}//${url.host}${url.pathname}${url.search}`, fileName };
}
