/**
 * Favicon helpers for the preview tab strip.
 *
 * Uses Google's s2 favicon endpoint (same approach as ami's tab strip).
 * Callers should always render a `<Globe />` fallback when the returned URL
 * fails to load via an `onError` handler.
 */
const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.host) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.host)}&sz=${size}`;
  } catch {
    return null;
  }
}
