/**
 * Per-origin favicon cache for the Browser panel — the package half of the
 * native favicon row. Native capture is engine-blocked for a package: the
 * desktop host captures PNG favicons (its preview `FaviconCapture` module)
 * and delivers them over desktop-internal IPC to the private
 * `browserFaviconStore`; `t3.browser/sessions` session objects and events
 * carry no favicon field and no op returns one, so a captured tier cannot
 * exist here and none is faked. What the contract does leave reachable is
 * the public-provider fallback the native tab strip already renders
 * (`faviconUrlForOrigin`: the public favicon service, public hosts only).
 * This module owns that tier's per-origin outcome: an origin whose provider
 * image failed to load renders the fallback glyph on every surface and
 * stops being requested.
 */
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";

/** Native parity: `BROWSER_FAVICON_MAX_ENTRIES` in the native favicon store. */
export const FAVICON_CACHE_MAX_ENTRIES = 40;
/** The size the native tab strip asks the public provider for. */
export const FAVICON_PROVIDER_SIZE = 32;

export type FaviconOriginEntry = { readonly providerFailedAt: number };
export type FaviconCache = { readonly byOrigin: Readonly<Record<string, FaviconOriginEntry>> };

export function emptyFaviconCache(): FaviconCache {
  return { byOrigin: {} };
}

function formatFaviconHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * The per-origin key — the plugin-side half of the native `faviconKey`:
 * http(s) only, hostname normalized, loopback spellings and `0.0.0.0` folded
 * onto `localhost`, default ports made explicit. The native fold of the
 * environment's own hostname is deliberately absent — no public contract
 * tells a plugin that hostname.
 */
export function faviconOriginKey(rawUrl: string): string | null {
  if (rawUrl.length === 0 || rawUrl.length > 4096) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = normalizeHostname(parsed.hostname);
  const canonicalHost = isLocalLoopbackHost(host) || host === "0.0.0.0" ? "localhost" : host;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${formatFaviconHost(canonicalHost)}:${port}`;
}

/**
 * Record that the provider image for this origin failed to load. An
 * older-or-equal timestamp than the recorded one is a no-op and returns the
 * same cache reference; past the cap the oldest-recorded origins drop off.
 */
export function recordProviderFaviconFailure(
  cache: FaviconCache,
  rawUrl: string,
  at: number,
): FaviconCache {
  const key = faviconOriginKey(rawUrl);
  if (!key) return cache;
  const existing = cache.byOrigin[key];
  if (existing && existing.providerFailedAt >= at) return cache;
  const byOrigin = { ...cache.byOrigin, [key]: { providerFailedAt: at } };
  const keys = Object.keys(byOrigin);
  if (keys.length <= FAVICON_CACHE_MAX_ENTRIES) return { byOrigin };
  const evict = new Set(
    keys
      .toSorted(
        (left, right) => byOrigin[right]!.providerFailedAt - byOrigin[left]!.providerFailedAt,
      )
      .slice(FAVICON_CACHE_MAX_ENTRIES),
  );
  return {
    byOrigin: Object.fromEntries(keys.filter((k) => !evict.has(k)).map((k) => [k, byOrigin[k]!])),
  };
}

export type FaviconResolution =
  | { readonly kind: "image"; readonly src: string }
  | { readonly kind: "glyph" };

const GLYPH: FaviconResolution = { kind: "glyph" };

/**
 * The fallback glyph a surface renders when no image resolves: the host's
 * first letter, uppercased — deterministic and network-free. A URL without
 * a usable host letter gets a neutral dot.
 */
export function faviconFallbackGlyph(rawUrl: string | null): string {
  if (!rawUrl) return "•";
  try {
    const letter = normalizeHostname(new URL(rawUrl).hostname).match(/[a-z\d]/i);
    return letter ? letter[0]!.toUpperCase() : "•";
  } catch {
    return "•";
  }
}

/**
 * What a surface renders for a page URL: the provider image when the origin
 * is public and has not failed, the glyph for everything else — non-URLs,
 * non-http(s), private/loopback hosts the provider must not be told about,
 * and origins whose provider image already failed.
 */
export function resolveFavicon(cache: FaviconCache, rawUrl: string | null): FaviconResolution {
  if (!rawUrl) return GLYPH;
  const key = faviconOriginKey(rawUrl);
  if (!key || cache.byOrigin[key]) return GLYPH;
  const src = faviconUrlForOrigin(rawUrl, FAVICON_PROVIDER_SIZE);
  return src ? { kind: "image", src } : GLYPH;
}
