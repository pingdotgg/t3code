/**
 * Per-origin favicon cache for the Browser panel — the package half of the
 * native favicon row. Two tiers, captured first like the native store:
 *
 * - captured: the desktop engine host captures the page's favicon, the
 *   server keeps it as a bounded asset, and a session carries only its
 *   `faviconRef`; `sessions.getFavicon` resolves the ref to bytes, recorded
 *   here per origin so every surface (tab strip, recents) shows it.
 * - provider: the public-provider image the native tab strip renders
 *   (`faviconUrlForOrigin`: public hosts only). An origin whose provider
 *   image failed to load renders the fallback glyph on every surface and
 *   stops being requested until the failure ages out, so a transient network
 *   blip does not suppress the image for the whole session.
 *
 * Refs are content hashes, so one ref can serve several origins: the result
 * of its single read is kept per ref. A tab renders its own ref's image, so
 * two tabs on one origin keep their own icons; each origin also remembers one
 * live ref's image for surfaces that know only a URL (recents, a tab whose
 * ref has not resolved). Applying the same sessions twice changes nothing.
 * A missing, stale, or failed capture simply leaves the provider tier.
 * Nothing schedules the age-out: a surface expires its origin's stale
 * failure when it mounts or navigates.
 */
import type { BrowserSession } from "@t3tools/extension-sdk/catalogue";
import type { ViewTabIndicators } from "@t3tools/extension-sdk/host";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";

/** Native parity: `BROWSER_FAVICON_MAX_ENTRIES` in the native favicon store. */
export const FAVICON_CACHE_MAX_ENTRIES = 40;
/** The size the native tab strip asks the public provider for. */
export const FAVICON_PROVIDER_SIZE = 32;
/** How long a recorded provider failure keeps its origin on the glyph. */
export const FAVICON_FAILURE_TTL_MS = 5 * 60_000;
/** At most this many `getFavicon` reads run at once; the rest queue (`faviconReads.ts`). */
export const MAX_FAVICON_READS = 8;
/** Ref results kept — above the origin cap so a panel's live tabs all keep their own icons. */
export const FAVICON_REF_MAX_ENTRIES = 256;

export type FaviconOriginEntry = { readonly providerFailedAt: number };
export type CapturedFavicon = {
  readonly ref: string;
  /** A `data:image/*` URL resolved from the ref. */
  readonly src: string;
  readonly capturedAt: number;
};
/** A ref's read result: the image, or null when it was refused, failed, or would not render. */
export type ResolvedFaviconRef = { readonly src: string | null; readonly resolvedAt: number };
export type FaviconCache = {
  readonly byOrigin: Readonly<Record<string, FaviconOriginEntry>>;
  readonly captured: Readonly<Record<string, CapturedFavicon>>;
  readonly resolved: Readonly<Record<string, ResolvedFaviconRef>>;
};

export function emptyFaviconCache(): FaviconCache {
  return { byOrigin: {}, captured: {}, resolved: {} };
}

/**
 * Keeps the `max` newest entries by `stamp`. `pinned` keys (what live sessions
 * show) are never evicted, so re-applying them cannot evict and re-add forever.
 */
function capEntries<T>(
  entries: Record<string, T>,
  stamp: (entry: T) => number,
  max = FAVICON_CACHE_MAX_ENTRIES,
  pinned: ReadonlySet<string> = new Set(),
): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  const keep = new Set([
    ...keys.filter((key) => pinned.has(key)),
    ...keys
      .filter((key) => !pinned.has(key))
      .toSorted((left, right) => stamp(entries[right]!) - stamp(entries[left]!))
      .slice(0, Math.max(0, max - pinned.size)),
  ]);
  return Object.fromEntries(keys.filter((key) => keep.has(key)).map((key) => [key, entries[key]!]));
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
  return {
    ...cache,
    byOrigin: capEntries(
      { ...cache.byOrigin, [key]: { providerFailedAt: at } },
      (entry) => entry.providerFailedAt,
    ),
  };
}

const CAPTURED_SRC = /^data:image\/[a-z.+-]+;base64,/i;

/**
 * Record the captured favicon resolved for this page's origin. Re-recording
 * the same ref is a no-op returning the same cache reference; past the cap
 * the oldest captures drop off (their origins fall back to the provider).
 */
export function recordCapturedFavicon(
  cache: FaviconCache,
  rawUrl: string,
  favicon: { readonly ref: string; readonly src: string },
  at: number,
): FaviconCache {
  const key = faviconOriginKey(rawUrl);
  if (!key || !CAPTURED_SRC.test(favicon.src)) return cache;
  if (cache.captured[key]?.ref === favicon.ref) return cache;
  return {
    ...cache,
    captured: capEntries(
      { ...cache.captured, [key]: { ref: favicon.ref, src: favicon.src, capturedAt: at } },
      (entry) => entry.capturedAt,
    ),
  };
}

/**
 * Drop a captured favicon that failed to render — the `ref` actually shown
 * (`FaviconResolution.ref`), else the origin's capture. The ref is marked
 * broken so it is neither shown, re-applied nor re-read; an origin showing it
 * falls back to the provider.
 */
export function dropCapturedFavicon(
  cache: FaviconCache,
  rawUrl: string,
  ref?: string | null,
): FaviconCache {
  const key = faviconOriginKey(rawUrl);
  const originCapture = key ? cache.captured[key] : undefined;
  const brokenRef = ref ?? originCapture?.ref;
  if (!key || !brokenRef) return cache;
  const resolved = cache.resolved[brokenRef];
  if (resolved?.src === null && originCapture?.ref !== brokenRef) return cache;
  const captured = { ...cache.captured };
  if (originCapture?.ref === brokenRef) delete captured[key];
  return {
    ...cache,
    captured,
    resolved: {
      ...cache.resolved,
      [brokenRef]: {
        src: null,
        resolvedAt: resolved?.resolvedAt ?? originCapture?.capturedAt ?? 0,
      },
    },
  };
}

/**
 * Record the result of one ref's read (null: refused or failed). Re-recording
 * the same result is a no-op returning the same cache reference; past the cap
 * the oldest results drop off.
 */
export function recordResolvedFaviconRef(
  cache: FaviconCache,
  ref: string,
  src: string | null,
  at: number,
): FaviconCache {
  const image = src !== null && CAPTURED_SRC.test(src) ? src : null;
  const existing = cache.resolved[ref];
  if (existing && existing.src === image) return cache;
  return {
    ...cache,
    resolved: capEntries(
      { ...cache.resolved, [ref]: { src: image, resolvedAt: at } },
      (entry) => entry.resolvedAt,
      FAVICON_REF_MAX_ENTRIES,
    ),
  };
}

/**
 * Give every origin a live session shows one resolved ref's image — so a ref
 * shared by several origins reaches each of them, whether the session arrived
 * before, during or after the read. An origin whose capture is already one of
 * its sessions' refs keeps it; otherwise the last session's ref wins. So the
 * result is stable: applying the same sessions again returns the same cache
 * reference, and tabs on one origin cannot overwrite each other.
 */
export function applyResolvedFaviconRefs(
  cache: FaviconCache,
  sessions: readonly BrowserSession[],
  at: number,
): FaviconCache {
  const refsByOrigin = new Map<string, string[]>();
  for (const session of sessions) {
    const ref = session.faviconRef;
    const key = session.navigation.url ? faviconOriginKey(session.navigation.url) : null;
    if (!ref || !key || !cache.resolved[ref]?.src) continue;
    refsByOrigin.set(key, [...(refsByOrigin.get(key) ?? []), ref]);
  }
  const updates: Record<string, CapturedFavicon> = {};
  for (const [key, refs] of refsByOrigin) {
    const current = cache.captured[key]?.ref;
    if (current !== undefined && refs.includes(current)) continue;
    const ref = refs.at(-1)!;
    updates[key] = { ref, src: cache.resolved[ref]!.src!, capturedAt: at };
  }
  if (Object.keys(updates).length === 0) return cache;
  return {
    ...cache,
    captured: capEntries(
      { ...cache.captured, ...updates },
      (entry) => entry.capturedAt,
      FAVICON_CACHE_MAX_ENTRIES,
      new Set(refsByOrigin.keys()),
    ),
  };
}

/**
 * Drop this origin's failure once it is older than `FAVICON_FAILURE_TTL_MS`
 * at `now`, so its provider image is tried again. A no-op returns the same
 * cache reference.
 */
export function expireStaleFaviconFailure(
  cache: FaviconCache,
  rawUrl: string | null,
  now: number,
): FaviconCache {
  const key = rawUrl ? faviconOriginKey(rawUrl) : null;
  const entry = key ? cache.byOrigin[key] : undefined;
  if (!key || !entry || now - entry.providerFailedAt < FAVICON_FAILURE_TTL_MS) return cache;
  const { [key]: _expired, ...byOrigin } = cache.byOrigin;
  return { ...cache, byOrigin };
}

export type FaviconResolution =
  /** `ref` is the capture actually shown — the tab's own, or its origin's fallback. */
  | {
      readonly kind: "image";
      readonly src: string;
      readonly tier: "captured";
      readonly ref: string;
    }
  | { readonly kind: "image"; readonly src: string; readonly tier: "provider" }
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
 * What a surface renders for a page URL: the tab's own `ref` image when it
 * resolved, else the origin's captured image (loopback included — the
 * capture came from the page itself), else
 * the provider image when the origin is public and has not failed, else the
 * glyph — non-URLs, non-http(s), private/loopback hosts the provider must
 * not be told about, and origins whose provider image already failed.
 */
export function resolveFavicon(
  cache: FaviconCache,
  rawUrl: string | null,
  ref?: string | null,
): FaviconResolution {
  if (!rawUrl) return GLYPH;
  const key = faviconOriginKey(rawUrl);
  if (!key) return GLYPH;
  const own = ref ? cache.resolved[ref]?.src : null;
  if (ref && own) return { kind: "image", src: own, tier: "captured", ref };
  const captured = cache.captured[key];
  if (captured) return { kind: "image", src: captured.src, tier: "captured", ref: captured.ref };
  if (cache.byOrigin[key]) return GLYPH;
  const src = faviconUrlForOrigin(rawUrl, FAVICON_PROVIDER_SIZE);
  return src ? { kind: "image", src, tier: "provider" } : GLYPH;
}

/**
 * Refs the sessions carry that still need a `getFavicon` read: no recorded
 * result and not already the capture for the page's origin. One entry per
 * ref; the read queue skips refs already read or reading.
 */
export function pendingFaviconRefs(
  cache: FaviconCache,
  sessions: readonly BrowserSession[],
): readonly string[] {
  const pending = new Set<string>();
  for (const session of sessions) {
    const ref = session.faviconRef;
    const url = session.navigation.url;
    if (!ref || !url || cache.resolved[ref]) continue;
    const key = faviconOriginKey(url);
    if (!key || cache.captured[key]?.ref === ref) continue;
    pending.add(ref);
  }
  return [...pending];
}

/**
 * The host-rendered chrome for the panel's own tab: the presented page and
 * its captured icon (the host adds the provider tier itself), and audio
 * across every session — "audible" while any unmuted page plays, "muted"
 * when only muted pages do. Null when there is nothing to show.
 */
export function panelTabIndicators(
  cache: FaviconCache,
  presented: BrowserSession | null,
  sessions: readonly BrowserSession[],
): ViewTabIndicators | null {
  const rawUrl = presented ? (presented.navigation.url ?? presented.requestedUrl) : null;
  const pageUrl = rawUrl && rawUrl.length <= 2048 && faviconOriginKey(rawUrl) ? rawUrl : null;
  const resolution = resolveFavicon(cache, pageUrl, presented?.faviconRef);
  const audible = sessions.filter((session) => session.audible === true);
  const audio = audible.some((session) => session.audioMuted !== true)
    ? "audible"
    : audible.length > 0
      ? "muted"
      : null;
  if (pageUrl === null && audio === null) return null;
  return {
    ...(pageUrl === null ? {} : { pageUrl }),
    ...(resolution.kind === "image" && resolution.tier === "captured"
      ? { faviconDataUrl: resolution.src }
      : {}),
    ...(audio === null ? {} : { audio }),
  };
}
