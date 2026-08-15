const REPO = "pingdotgg/t3code";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const LATEST_CACHE_KEY = "t3code-latest-release";
const NIGHTLY_CACHE_KEY = "t3code-nightly-release";
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1_000;
const NIGHTLY_TAG_PATTERN = /-nightly\.(\d{8})\.(\d+)$/;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface ReleasePlatform {
  os: "mac" | "win" | "linux";
  arch?: "arm64" | "x64";
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

export function findReleaseAssetUrl(
  assets: readonly ReleaseAsset[],
  platform: ReleasePlatform,
): string | null {
  if (platform.os === "win") {
    return assets.find((asset) => asset.name.endsWith("-x64.exe"))?.browser_download_url ?? null;
  }
  if (platform.os === "mac") {
    if (!platform.arch) return null;
    return (
      assets.find((asset) => asset.name.endsWith(`-${platform.arch}.dmg`))?.browser_download_url ??
      null
    );
  }
  return assets.find((asset) => asset.name.endsWith(".AppImage"))?.browser_download_url ?? null;
}

interface CachedRelease {
  cachedAt: number;
  release: Release;
}

function readCachedRelease(key: string): Release | null {
  let cached: string | null;
  try {
    cached = sessionStorage.getItem(key);
  } catch {
    return null;
  }
  if (!cached) return null;

  try {
    const value: unknown = JSON.parse(cached);
    if (
      value !== null &&
      typeof value === "object" &&
      "cachedAt" in value &&
      typeof value.cachedAt === "number" &&
      "release" in value &&
      isRelease(value.release) &&
      Date.now() - value.cachedAt < RELEASE_CACHE_TTL_MS
    ) {
      return value.release;
    }
    removeCachedRelease(key);
    return null;
  } catch {
    removeCachedRelease(key);
    return null;
  }
}

function writeCachedRelease(key: string, release: Release): void {
  const cached: CachedRelease = { cachedAt: Date.now(), release };
  try {
    sessionStorage.setItem(key, JSON.stringify(cached));
  } catch {
    // Release loading still succeeds when storage is unavailable or full.
  }
}

function removeCachedRelease(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // An inaccessible cache is equivalent to a miss.
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub release request failed with ${response.status}`);
  }
  return response.json();
}

function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<Release>;
  return (
    typeof release.tag_name === "string" &&
    typeof release.html_url === "string" &&
    Array.isArray(release.assets)
  );
}

export function selectNightlyRelease(releases: readonly Release[]): Release | null {
  let selected: { release: Release; date: string; run: number } | null = null;

  for (const release of releases) {
    if (release.draft || release.prerelease !== true) continue;
    const match = NIGHTLY_TAG_PATTERN.exec(release.tag_name);
    if (!match) continue;

    const candidate = {
      release,
      date: match[1]!,
      run: Number(match[2]),
    };
    if (
      selected === null ||
      candidate.date > selected.date ||
      (candidate.date === selected.date && candidate.run > selected.run)
    ) {
      selected = candidate;
    }
  }

  return selected?.release ?? null;
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = readCachedRelease(LATEST_CACHE_KEY);
  if (cached) return cached;

  const data = await fetchJson(LATEST_API_URL);
  if (!isRelease(data)) throw new Error("GitHub returned an invalid latest release");

  writeCachedRelease(LATEST_CACHE_KEY, data);
  return data;
}

export async function fetchNightlyRelease(): Promise<Release> {
  const cached = readCachedRelease(NIGHTLY_CACHE_KEY);
  if (cached) return cached;

  const data = await fetchJson(RELEASES_API_URL);
  if (!Array.isArray(data)) throw new Error("GitHub returned an invalid releases list");

  const nightly = selectNightlyRelease(data.filter(isRelease));
  if (!nightly) throw new Error("No nightly release was found");

  writeCachedRelease(NIGHTLY_CACHE_KEY, nightly);
  return nightly;
}
