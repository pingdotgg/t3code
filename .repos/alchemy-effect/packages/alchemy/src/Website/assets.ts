/**
 * Static-asset behavior shared across website hosts.
 *
 * Origin routing (`notFoundHandling`, `htmlHandling`) is host-agnostic.
 * `Content-Type` / `Cache-Control` used when uploading a client directory
 * (Fly Tigris today) are also host-agnostic HTTP policy: HTML is never
 * cached so a deploy is visible immediately; content-hashed files are
 * immutable. CDN topology (CloudFront vs Tigris vs none) stays host-specific.
 *
 * AWS.Website.AssetDeployment has its own table: it takes `fileOptions` /
 * `textEncoding` overrides and historically used `application/javascript`.
 * Do not force that API onto this module until those knobs are needed here.
 *
 * Keep {@link contentTypeOf} in sync with the MIME table inlined by
 * `makeNodeServeEntrySource` (`frontend-frameworks` NodeServe) — that
 * generated origin cannot import this file.
 */

/**
 * How unmatched GET paths are answered. Same names as Cloudflare
 * Workers `assets.notFoundHandling`.
 */
export type WebsiteNotFoundHandling =
  | "none"
  | "single-page-application"
  | "404-page";

/**
 * Static-asset routing on the origin (`notFoundHandling`, `htmlHandling`).
 */
export interface WebsiteAssetsProps {
  notFoundHandling?: WebsiteNotFoundHandling;
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Map {@link WebsiteAssetsProps} onto the generated Node serve entry. */
export const staticConfigFromAssets = (
  assets: WebsiteAssetsProps | undefined,
  defaults?: { notFoundHandling?: WebsiteNotFoundHandling },
): { spa?: boolean; errorPage?: string } => {
  const handling = assets?.notFoundHandling ?? defaults?.notFoundHandling;
  if (handling === "single-page-application") return { spa: true };
  if (handling === "404-page") return { errorPage: "404.html" };
  if (handling === "none") return { spa: false };
  return {};
};

/** HTML documents: never cached so a new deploy is visible immediately. */
export const htmlCacheControl = "max-age=0,no-cache,no-store,must-revalidate";

/** Content-hashed static files (JS/CSS/images): cache forever. */
export const assetCacheControl = "max-age=31536000,public,immutable";

/**
 * `Content-Type` for a static website file, from its extension.
 *
 * JS is `text/javascript` (the HTML-spec JavaScript MIME type) so
 * `<script type="module">` loads. Unknown extensions are
 * `application/octet-stream`.
 */
export const contentTypeOf = (relative: string): string => {
  const slash = Math.max(relative.lastIndexOf("/"), relative.lastIndexOf("\\"));
  const base = slash >= 0 ? relative.slice(slash + 1) : relative;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "txt":
      return "text/plain; charset=utf-8";
    case "wasm":
      return "application/wasm";
    case "map":
      return "application/json";
    default:
      return "application/octet-stream";
  }
};

/**
 * `Cache-Control` for a static website file. HTML (and `.htm`) is never
 * cached; everything else is immutable. Frameworks content-hash JS/CSS
 * into `/assets/...`, so a new deploy changes the URL instead of mutating
 * a cached object.
 */
export const cacheControlOf = (relative: string): string => {
  const lower = relative.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm")
    ? htmlCacheControl
    : assetCacheControl;
};
