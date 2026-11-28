import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

// A phone or a browser off the GitLab network cannot load this URL; the T3 server can.
const USER_AVATAR_PATH = /^\/uploads\/-\/system\/user\/avatar\/\d+\/([^/]+)$/u;

export const isGitLabHostname = (hostname: string) =>
  hostname === "gitlab.com" || hostname.split(".").includes("gitlab");

export const isBlockedGitLabMediaHostname = (hostname: string) => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host)) return true;
  return host.includes(":");
};

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // Self-managed GitLab is often not named "gitlab", and its SSH host is not its web origin.
  if (isBlockedGitLabMediaHostname(url.hostname)) return null;
  const fileName = USER_AVATAR_PATH.exec(url.pathname)?.[1];
  return fileName === undefined
    ? null
    : { fetchUrl: `${url.protocol}//${url.host}${url.pathname}${url.search}`, fileName };
}
