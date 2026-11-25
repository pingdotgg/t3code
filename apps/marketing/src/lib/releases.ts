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
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
  return response.json();
}

async function fetchStable(): Promise<Release> {
  return fetchJson(LATEST_API_URL);
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
    const response = await fetch(LATEST_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Release;
    return Array.isArray(data?.assets) ? data : null;
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
