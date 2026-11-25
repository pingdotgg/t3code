import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease, pickAsset } from "./releases";

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
