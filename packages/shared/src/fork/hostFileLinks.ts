import { POSIX_FILE_ROOT_PREFIXES, safeDecodeURIComponent } from "../markdownLinks.ts";

// A deploy can serve an environment's files at their absolute paths on the app's own origin.
// `/work/` is the usual project root on such machines; the other roots are the ones prose
// paths already use. App routes (`/assets/`, `/api/`, `/chat/`) stay web links.
const HOST_FILE_ROOTS = [...POSIX_FILE_ROOT_PREFIXES, "/work/"];

/**
 * The file-link href (`/abs/path#L1`, still percent-encoded) that `href` names on the
 * environment served at `environmentOrigins`, or null when `href` is not such a URL.
 */
export function hostFileUrlPath(
  href: string,
  environmentOrigins: readonly string[],
): string | null {
  if (environmentOrigins.length === 0 || !/^https?:\/\//i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!environmentOrigins.includes(url.origin) || url.username || url.password || url.search) {
    return null;
  }
  const path = safeDecodeURIComponent(url.pathname);
  return HOST_FILE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length)
    ? `${url.pathname}${url.hash}`
    : null;
}
