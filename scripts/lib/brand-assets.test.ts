import { describe, expect, it } from "vitest";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
  resolveWebAssetBrandForConfiguredChannel,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps server publish web assets to production icons", () => {
    expect(PUBLISH_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebPwa192Png,
        targetRelativePath: "dist/client/pwa-192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebPwa512Png,
        targetRelativePath: "dist/client/pwa-512.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebPwa512Png,
      targetRelativePath: "apps/web/dist/pwa-512.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("defaults configured web asset channels to production", () => {
    expect(resolveWebAssetBrandForConfiguredChannel(undefined)).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel("preview")).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel(" nightly ")).toBe("nightly");
  });
});
