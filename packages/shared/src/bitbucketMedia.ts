const API_DOWNLOAD_PREFIX = "https://api.bitbucket.org/2.0/repositories";
const WEB_DOWNLOAD_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/downloads\/([^/]+)$/u;
const API_DOWNLOAD_PATH_PATTERN = /^\/2\.0\/repositories\/([^/]+)\/([^/]+)\/downloads\/([^/]+)$/u;

/** The web host ignores API credentials; private Downloads must use the API endpoint. */
export function bitbucketMediaFetchUrl(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const download =
    host === "bitbucket.org" || host === "www.bitbucket.org"
      ? WEB_DOWNLOAD_PATH_PATTERN.exec(url.pathname)
      : host === "api.bitbucket.org"
        ? API_DOWNLOAD_PATH_PATTERN.exec(url.pathname)
        : null;
  return download
    ? `${API_DOWNLOAD_PREFIX}/${download[1]}/${download[2]}/downloads/${download[3]}`
    : null;
}
