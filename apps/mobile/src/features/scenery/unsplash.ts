import Constants from "expo-constants";

/**
 * Minimal Unsplash REST client (search + download registration), the mobile
 * port of the mac app's UnsplashClient. Read-only public endpoints, so only
 * the access key is needed — the key arrives at build time via
 * EXPO_PUBLIC_UNSPLASH_ACCESS_KEY (app.config.ts extra.unsplash) and is never
 * committed. Without a key every caller degrades to gradient washes.
 */

/** utm_source value Unsplash attribution links must carry. */
export const UNSPLASH_APP_NAME = "SergeCode";
export const UNSPLASH_UTM = `?utm_source=${UNSPLASH_APP_NAME}&utm_medium=referral`;

/**
 * One photo from the Unsplash API, reduced to the fields the scenery system
 * needs. Persisted in pool.json, so keep the shape stable.
 */
export interface SceneryPhoto {
  readonly id: string;
  /** Curated Dolomites display name paired with the photo at pool build. */
  readonly name: string;
  /**
   * Real place label resolved from Unsplash *location* metadata only (mirrors
   * `UnsplashClient.APIPhoto.suggestedSceneName` on mac) — never `description`
   * / `alt_description` captions, which are machine prose and must not become
   * scene names. Null when Unsplash reported no location for the photo; the
   * pool then falls back to the curated `SCENE_NAMES` cycle for `name`.
   */
  readonly placeName: string | null;
  /** Average color reported by Unsplash ("#RRGGBB"); wash while loading. */
  readonly averageColorHex: string | null;
  /** `urls.regular` (1080w) — legacy fallback when rawURL is absent. */
  readonly heroURL: string;
  /** `urls.thumb` (~200w) — list-row thumbnails. */
  readonly thumbURL: string;
  /** Unprocessed base image (`urls.raw`); sized via imgix params. */
  readonly rawURL: string | null;
  /** `links.download_location` — pinged once when the photo is used. */
  readonly downloadLocationURL: string | null;
  readonly photographerName: string;
  readonly photographerProfileURL: string | null;
}

interface UnsplashSearchResult {
  readonly id: string;
  readonly color?: string | null;
  readonly location?: {
    readonly name?: string | null;
    readonly city?: string | null;
    readonly country?: string | null;
  } | null;
  readonly urls: { readonly raw: string; readonly regular: string; readonly thumb: string };
  readonly links?: { readonly download_location?: string | null } | null;
  readonly user: {
    readonly name: string;
    readonly links?: { readonly html?: string | null } | null;
  };
}

/**
 * Best-effort place label from Unsplash *location* metadata only — the
 * mobile port of `UnsplashClient.APIPhoto.suggestedSceneName` on mac. Never
 * falls back to `description` / `alt_description` captions; those are
 * machine prose and must not become scene names.
 */
export function extractPlaceName(location: UnsplashSearchResult["location"]): string | null {
  const name = location?.name?.trim();
  if (name !== undefined && name.length > 0) {
    return shortenSceneName(name);
  }
  const city = location?.city?.trim();
  if (city !== undefined && city.length > 0) {
    return shortenSceneName(city);
  }
  const country = location?.country?.trim();
  if (country !== undefined && country.length > 0) {
    return shortenSceneName(country);
  }
  return null;
}

function shortenSceneName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ");
  if (collapsed.length <= 48) return collapsed;
  return `${collapsed.slice(0, 45).trimEnd()}...`;
}

/**
 * Build-time key lookup, dev fallback to the inlined EXPO_PUBLIC env var.
 * null when absent — callers must degrade to washes.
 */
export function resolveUnsplashAccessKey(): string | null {
  const extra = Constants.expoConfig?.extra as
    | { unsplash?: { accessKey?: string | null } }
    | undefined;
  const fromExtra = extra?.unsplash?.accessKey;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    return fromExtra;
  }
  const fromEnv = process.env.EXPO_PUBLIC_UNSPLASH_ACCESS_KEY;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : null;
}

export interface UnsplashClient {
  readonly searchPhotos: (query: string, count: number) => Promise<ReadonlyArray<SceneryPhoto>>;
  /**
   * Ping `links.download_location` — required by the Unsplash guidelines
   * whenever a photo is put to use. Fire-and-forget; failures are benign.
   */
  readonly registerDownload: (downloadLocationURL: string) => Promise<void>;
}

/** null when no key is configured. */
export function makeUnsplashClient(
  accessKey: string | null = resolveUnsplashAccessKey(),
  fetchFn: typeof fetch = fetch,
): UnsplashClient | null {
  if (accessKey === null || accessKey.length === 0) {
    return null;
  }
  const headers = {
    Authorization: `Client-ID ${accessKey}`,
    "Accept-Version": "v1",
  };
  return {
    searchPhotos: async (query, count) => {
      const params = new URLSearchParams({
        query,
        per_page: String(count),
        orientation: "landscape",
        content_filter: "high",
      });
      const response = await fetchFn(`https://api.unsplash.com/search/photos?${params}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(`Unsplash search failed with status ${response.status}`);
      }
      const body = (await response.json()) as { results?: ReadonlyArray<UnsplashSearchResult> };
      return (body.results ?? []).map((photo) => ({
        id: photo.id,
        // Placeholder; SceneryStore pairs curated scene names at pool build.
        name: "",
        placeName: extractPlaceName(photo.location),
        averageColorHex: photo.color ?? null,
        heroURL: photo.urls.regular,
        thumbURL: photo.urls.thumb,
        rawURL: photo.urls.raw,
        downloadLocationURL: photo.links?.download_location ?? null,
        photographerName: photo.user.name,
        photographerProfileURL: photo.user.links?.html ?? null,
      }));
    },
    registerDownload: async (downloadLocationURL) => {
      try {
        await fetchFn(downloadLocationURL, { headers });
      } catch {
        // Guideline ping only; never surface failures.
      }
    },
  };
}

const SIZING_PARAMS = ["w", "h", "q", "fm", "fit", "crop", "blur", "sat"];

/**
 * Rewrites an Unsplash/imgix URL to a specific render width (and optional
 * pre-blur/saturation): replaces any existing sizing params, keeps identity
 * params (ixid) intact. `fit=max` never upscales past the original asset.
 * Pre-blur on the CDN replaces a runtime gaussian — deterministic, free
 * on-device, and identical on Android. `saturation` (imgix `sat`, -100..100)
 * mirrors the mac chat wallpaper's `.saturation(1.05)` boost, which has no
 * direct RN/Image equivalent.
 */
export function sizedImageURL(
  url: string,
  options: { width: number; blur?: number; saturation?: number },
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const param of SIZING_PARAMS) {
    parsed.searchParams.delete(param);
  }
  parsed.searchParams.set("w", String(options.width));
  parsed.searchParams.set("q", "85");
  parsed.searchParams.set("fm", "jpg");
  parsed.searchParams.set("fit", "max");
  if (options.blur !== undefined && options.blur > 0) {
    parsed.searchParams.set("blur", String(options.blur));
  }
  if (options.saturation !== undefined && options.saturation !== 0) {
    parsed.searchParams.set("sat", String(options.saturation));
  }
  return parsed.toString();
}
