import { CDN_ORIGIN } from "./site";
import type { Platform } from "./platform";

const REPO = "penouc/tix";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `${CDN_ORIGIN}/api/releases/latest`;
const LIST_API_URL = `${CDN_ORIGIN}/api/releases`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  updated_at?: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

function isStableAndroidRelease(release: Release): boolean {
  if (release.draft || release.prerelease) return false;
  if (release.tag_name.includes("-nightly.") || release.tag_name.includes("-preview."))
    return false;
  return (
    Array.isArray(release.assets) && release.assets.some((asset) => asset.name.endsWith(".apk"))
  );
}

function androidAssetTimestamp(release: Release): number {
  const apk = release.assets.find((asset) => asset.name.endsWith(".apk"));
  const raw = apk?.updated_at ?? release.published_at;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function mergeLatestAndroidRelease(
  stable: Release,
  releases: ReadonlyArray<Release>,
): Release {
  const stableHasApk = stable.assets.some((asset) => asset.name.endsWith(".apk"));
  let best: Release | null = stableHasApk ? stable : null;
  let bestTime = best ? androidAssetTimestamp(best) : -1;

  for (const candidate of releases) {
    if (!isStableAndroidRelease(candidate)) continue;
    const candidateTime = androidAssetTimestamp(candidate);
    if (best === null || candidateTime > bestTime) {
      best = candidate;
      bestTime = candidateTime;
    }
  }

  if (!best || best.tag_name === stable.tag_name) return stable;

  const androidAssets = best.assets.filter(
    (asset) => asset.name.endsWith(".apk") || asset.name.endsWith(".apk.sha256"),
  );
  const nonAndroidAssets = stable.assets.filter(
    (asset) => !asset.name.endsWith(".apk") && !asset.name.endsWith(".apk.sha256"),
  );
  return {
    ...stable,
    assets: [...nonAndroidAssets, ...androidAssets],
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(
    url,
    signal ? { headers: { Accept: "application/json" }, signal } : undefined,
  );
  if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
  return response.json();
}

async function fetchStable(): Promise<Release> {
  const [stable, list] = await Promise.all([
    fetchJson<Release>(LATEST_API_URL),
    fetchJson<Release[]>(LIST_API_URL).catch(() => [] as Release[]),
  ]);
  return mergeLatestAndroidRelease(stable, Array.isArray(list) ? list : []);
}

async function fetchNightly(): Promise<Release> {
  const list = await fetchJson<Release[]>(LIST_API_URL);
  const nightly = Array.isArray(list)
    ? list.find((release) => release.tag_name?.includes("-nightly."))
    : undefined;
  if (!nightly) throw new Error("No nightly release in the latest page");
  return nightly;
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  return channel === "nightly" ? fetchNightly() : fetchStable();
}

export async function fetchLatestReleaseAtBuild(): Promise<Release | null> {
  try {
    const signal = AbortSignal.timeout(8_000);
    const [stable, list] = await Promise.all([
      fetchJson<Release>(LATEST_API_URL, signal),
      fetchJson<Release[]>(LIST_API_URL, signal).catch(() => [] as Release[]),
    ]);
    if (!Array.isArray(stable?.assets)) return null;
    return mergeLatestAndroidRelease(stable, Array.isArray(list) ? list : []);
  } catch {
    return null;
  }
}

export function pickAssetByPattern(
  assets: ReadonlyArray<ReleaseAsset>,
  suffixes: ReadonlyArray<string>,
): ReleaseAsset | null {
  for (const suffix of suffixes) {
    const found = assets.find((asset) => asset.name.endsWith(suffix));
    if (found) return found;
  }
  return null;
}

export function pickAsset(assets: ReadonlyArray<ReleaseAsset>, platform: Platform): string | null {
  if (platform.os === "mac") {
    return (
      assets.find((asset) => asset.name.endsWith("arm64.dmg"))?.browser_download_url ??
      assets.find((asset) => asset.name.endsWith(".dmg"))?.browser_download_url ??
      null
    );
  }
  if (platform.os === "win") {
    return (
      assets.find((asset) => asset.name.endsWith("-x64.exe"))?.browser_download_url ??
      assets.find((asset) => asset.name.endsWith(".exe"))?.browser_download_url ??
      null
    );
  }
  if (platform.os === "linux") {
    return (
      assets.find((asset) => asset.name.endsWith("x86_64.AppImage"))?.browser_download_url ??
      assets.find((asset) => asset.name.endsWith(".AppImage"))?.browser_download_url ??
      assets.find((asset) => asset.name.endsWith(".tar.gz"))?.browser_download_url ??
      null
    );
  }
  if (platform.os === "android") {
    return assets.find((asset) => asset.name.endsWith(".apk"))?.browser_download_url ?? null;
  }
  return null;
}
