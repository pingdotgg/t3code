import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease, mergeLatestAndroidRelease, pickAsset, type Release } from "./releases";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestRelease", () => {
  it("rejects a GitHub API error response instead of returning it as a release", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async () =>
      Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
    );

    await expect(fetchLatestRelease("stable")).rejects.toThrow("403");
  });

  it("merges a newer mobile-v* APK into the stable desktop release", async () => {
    const stable: Release = {
      tag_name: "v0.1.14",
      html_url: "https://github.com/penouc/tix/releases/tag/v0.1.14",
      published_at: "2026-11-25T13:51:06Z",
      assets: [
        {
          name: "tix-0.1.14-arm64.dmg",
          browser_download_url:
            "https://cdn.penglei.dev/releases/download/v0.1.14/tix-0.1.14-arm64.dmg",
        },
        {
          name: "tix-android-0.1.14.apk",
          browser_download_url:
            "https://cdn.penglei.dev/releases/download/v0.1.14/tix-android-0.1.14.apk",
          updated_at: "2026-11-25T14:27:37Z",
        },
        {
          name: "tix-android-0.1.14.apk.sha256",
          browser_download_url:
            "https://cdn.penglei.dev/releases/download/v0.1.14/tix-android-0.1.14.apk.sha256",
          updated_at: "2026-11-25T14:27:33Z",
        },
      ],
    };
    const mobile: Release = {
      tag_name: "mobile-v2.3.0",
      html_url: "https://github.com/penouc/tix/releases/tag/mobile-v2.3.0",
      published_at: "2026-11-25T16:47:26Z",
      assets: [
        {
          name: "tix-android-2.3.0.apk",
          browser_download_url:
            "https://cdn.penglei.dev/releases/download/mobile-v2.3.0/tix-android-2.3.0.apk",
          updated_at: "2026-11-26T03:12:15Z",
        },
        {
          name: "tix-android-2.3.0.apk.sha256",
          browser_download_url:
            "https://cdn.penglei.dev/releases/download/mobile-v2.3.0/tix-android-2.3.0.apk.sha256",
          updated_at: "2026-11-26T03:11:49Z",
        },
      ],
    };

    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(url.endsWith("/latest") ? stable : [stable, mobile]),
    );

    const resolved = await fetchLatestRelease("stable");
    expect(resolved.tag_name).toBe("v0.1.14");
    expect(pickAsset(resolved.assets, { os: "mac" })).toBe(
      "https://cdn.penglei.dev/releases/download/v0.1.14/tix-0.1.14-arm64.dmg",
    );
    expect(pickAsset(resolved.assets, { os: "android" })).toBe(
      "https://cdn.penglei.dev/releases/download/mobile-v2.3.0/tix-android-2.3.0.apk",
    );
    expect(resolved.assets.map((asset) => asset.name)).toEqual([
      "tix-0.1.14-arm64.dmg",
      "tix-android-2.3.0.apk",
      "tix-android-2.3.0.apk.sha256",
    ]);
  });
});

describe("mergeLatestAndroidRelease", () => {
  it("ignores draft, prerelease, and nightly releases", () => {
    const stable: Release = {
      tag_name: "v0.1.14",
      html_url: "https://github.com/penouc/tix/releases/tag/v0.1.14",
      published_at: "2026-11-25T13:51:06Z",
      assets: [
        {
          name: "tix-android-0.1.14.apk",
          browser_download_url: "https://cdn.penglei.dev/old.apk",
          updated_at: "2026-11-25T14:27:37Z",
        },
      ],
    };
    const prerelease: Release = {
      tag_name: "mobile-v2.4.0-rc.1",
      html_url: "https://github.com/penouc/tix/releases/tag/mobile-v2.4.0-rc.1",
      published_at: "2026-11-26T05:00:00Z",
      prerelease: true,
      assets: [
        {
          name: "tix-android-2.4.0-rc.1.apk",
          browser_download_url: "https://cdn.penglei.dev/rc.apk",
          updated_at: "2026-11-26T05:00:00Z",
        },
      ],
    };

    const resolved = mergeLatestAndroidRelease(stable, [prerelease]);
    expect(pickAsset(resolved.assets, { os: "android" })).toBe("https://cdn.penglei.dev/old.apk");
  });
});

describe("pickAsset", () => {
  const assets = [
    { name: "tix-android-0.1.12.apk", browser_download_url: "https://cdn.penglei.dev/apk" },
    { name: "tix-x86_64.AppImage", browser_download_url: "https://cdn.penglei.dev/appimage" },
    { name: "T3-Code-0.1.12-x64.exe", browser_download_url: "https://cdn.penglei.dev/exe" },
    { name: "tix-0.1.12-arm64.dmg", browser_download_url: "https://cdn.penglei.dev/dmg" },
  ];

  it("picks the matching CDN asset for each supported platform", () => {
    expect(pickAsset(assets, { os: "mac" })).toBe("https://cdn.penglei.dev/dmg");
    expect(pickAsset(assets, { os: "win" })).toBe("https://cdn.penglei.dev/exe");
    expect(pickAsset(assets, { os: "linux" })).toBe("https://cdn.penglei.dev/appimage");
    expect(pickAsset(assets, { os: "android" })).toBe("https://cdn.penglei.dev/apk");
    expect(pickAsset(assets, { os: "ios" })).toBeNull();
  });
});
