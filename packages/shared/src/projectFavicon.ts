export const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";

const PROJECT_FAVICON_RELOAD_PARAM = "faviconReload";

/**
 * Append a cache-busting query parameter so the browser re-fetches a project
 * favicon whose URL is otherwise stable (the asset URL is derived from the
 * project path, so an edited favicon keeps the same URL and stays cached).
 *
 * `nonce <= 0` returns the URL untouched so the first render uses the plain,
 * shared URL and stays cache-friendly until a reload is explicitly requested.
 */
export function withProjectFaviconReloadParam(url: string, nonce: number): string {
  if (!Number.isFinite(nonce) || nonce <= 0) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${PROJECT_FAVICON_RELOAD_PARAM}=${nonce}`;
}

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1) === PROJECT_FAVICON_FALLBACK_MARKER;
  } catch {
    return false;
  }
}
