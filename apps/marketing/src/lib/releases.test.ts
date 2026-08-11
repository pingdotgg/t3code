import { describe, expect, it } from "vite-plus/test";
import { findReleaseAssetUrl, selectNightlyRelease, type Release } from "./releases";

function release(
  tag_name: string,
  options: Pick<Release, "draft" | "prerelease"> = {
    draft: false,
    prerelease: true,
  },
): Release {
  return {
    tag_name,
    html_url: `https://github.com/pingdotgg/t3code/releases/tag/${tag_name}`,
    assets: [],
    ...options,
  };
}

describe("selectNightlyRelease", () => {
  it("selects the newest published nightly prerelease regardless of list order", () => {
    const nightly = release("v0.0.32-nightly.20260729.951");

    expect(
      selectNightlyRelease([
        release("v0.0.33-nightly.20260730.1", { draft: true, prerelease: true }),
        release("v0.0.32-nightly.20260729.949"),
        release("v0.0.32"),
        release("v0.0.32-nightly.20260728.912"),
        nightly,
      ]),
    ).toBe(nightly);
  });

  it("uses the run number to order nightlies from the same date", () => {
    const nightly = release("v0.0.32-nightly.20260729.1002");

    expect(
      selectNightlyRelease([
        release("v0.0.32-nightly.20260729.999"),
        nightly,
        release("v0.0.33-nightly.20260729.1001"),
      ]),
    ).toBe(nightly);
  });

  it("ignores prereleases that are not nightly builds", () => {
    expect(selectNightlyRelease([release("v0.0.33-beta.1")])).toBeNull();
  });
});

describe("findReleaseAssetUrl", () => {
  const assets = [
    {
      name: "T3-Code-v1.2.3-arm64.dmg",
      browser_download_url: "https://example.com/arm64.dmg",
    },
    {
      name: "T3-Code-v1.2.3-x64.dmg",
      browser_download_url: "https://example.com/x64.dmg",
    },
    {
      name: "T3-Code-v1.2.3-x64.exe",
      browser_download_url: "https://example.com/x64.exe",
    },
    {
      name: "T3-Code-v1.2.3.AppImage",
      browser_download_url: "https://example.com/appimage",
    },
  ];

  it("does not guess a macOS architecture", () => {
    expect(findReleaseAssetUrl(assets, { os: "mac" })).toBeNull();
  });

  it("selects a macOS asset when the architecture is known", () => {
    expect(findReleaseAssetUrl(assets, { os: "mac", arch: "x64" })).toBe(
      "https://example.com/x64.dmg",
    );
  });

  it("selects platform-specific Windows and Linux assets", () => {
    expect(findReleaseAssetUrl(assets, { os: "win" })).toBe("https://example.com/x64.exe");
    expect(findReleaseAssetUrl(assets, { os: "linux" })).toBe("https://example.com/appimage");
  });
});
