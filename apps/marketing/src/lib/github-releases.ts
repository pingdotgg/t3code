const REPO = "pingdotgg/t3code";
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface PlatformAsset {
  readonly url: string;
  readonly name: string;
}

export interface ReleaseDownloads {
  readonly version: string;
  readonly macosArm64: PlatformAsset | undefined;
  readonly macosX64: PlatformAsset | undefined;
  readonly linux: PlatformAsset | undefined;
  readonly windows: PlatformAsset | undefined;
  readonly releasesUrl: string;
}

interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface GitHubRelease {
  readonly tag_name: string;
  readonly assets: readonly GitHubAsset[];
}

const FALLBACK: ReleaseDownloads = {
  version: "",
  macosArm64: undefined,
  macosX64: undefined,
  linux: undefined,
  windows: undefined,
  releasesUrl: RELEASES_URL,
};

function findAsset(
  assets: readonly GitHubAsset[],
  test: (name: string) => boolean,
): PlatformAsset | undefined {
  const asset = assets.find((a) => test(a.name));
  return asset ? { url: asset.browser_download_url, name: asset.name } : undefined;
}

export async function fetchLatestRelease(): Promise<ReleaseDownloads> {
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return FALLBACK;

    const release = (await res.json()) as GitHubRelease;
    const assets = release.assets ?? [];
    const version = release.tag_name?.replace(/^v/, "") ?? "";

    return {
      version,
      macosArm64: findAsset(assets, (n) => n.endsWith(".dmg") && n.includes("arm64")),
      macosX64: findAsset(assets, (n) => n.endsWith(".dmg") && !n.includes("arm64")),
      linux: findAsset(assets, (n) => n.endsWith(".AppImage")),
      windows: findAsset(assets, (n) => n.endsWith(".exe") && !n.endsWith(".blockmap")),
      releasesUrl: RELEASES_URL,
    };
  } catch {
    return FALLBACK;
  }
}
