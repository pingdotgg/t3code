/**
 * Media a pull request body points at in a Bitbucket Cloud repository's Downloads. A private
 * repository answers the `bitbucket.org/<workspace>/<repo>/downloads/<file>` link a description
 * carries with 401 to anything but a signed-in browser, and that web host ignores an API token
 * too. The API's download endpoint for the same file honours the token and redirects to a signed
 * object URL, so the server fetches that with the Bitbucket credential and hands the bytes back.
 *
 * The signed object URL itself is not kept here: it expires within the hour, so a body that
 * embedded one has already broken on its own and no credential brings it back.
 */

const API_DOWNLOAD_PREFIX = "https://api.bitbucket.org/2.0/repositories";
const WEB_DOWNLOAD_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/downloads\/([^/]+)$/u;
const API_DOWNLOAD_PATH_PATTERN = /^\/2\.0\/repositories\/([^/]+)\/([^/]+)\/downloads\/([^/]+)$/u;

/**
 * The API download URL to fetch with a Bitbucket credential for `source`, or null when the
 * source is not a Bitbucket download — those keep loading directly, exactly as they do today.
 */
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
  // Port, userinfo, query, and fragment say nothing about which file Bitbucket will serve.
  return download
    ? `${API_DOWNLOAD_PREFIX}/${download[1]}/${download[2]}/downloads/${download[3]}`
    : null;
}
