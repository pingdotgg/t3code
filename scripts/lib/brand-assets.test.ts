import { describe, expect, it } from "vite-plus/test";

import {
  applyMunimBootWordmarkClass,
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebIcon192Png,
        targetRelativePath: "dist/client/icon-192x192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebIcon512Png,
        targetRelativePath: "dist/client/icon-512x512.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("ships a boot wordmark only for the Munim brand", () => {
    expect(resolveWebIconOverrides("munim", "apps/server/dist/client")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.munimWebWordmarkPng,
      targetRelativePath: "apps/server/dist/client/boot-wordmark.png",
    });
    expect(
      resolveWebIconOverrides("production", "apps/server/dist/client").some((override) =>
        override.targetRelativePath.endsWith("/boot-wordmark.png"),
      ),
    ).toBe(false);
  });

  it("stamps the Munim boot wordmark class onto the html root", () => {
    expect(applyMunimBootWordmarkClass('<html lang="en">')).toBe(
      '<html class="boot-has-wordmark" lang="en">',
    );
    expect(applyMunimBootWordmarkClass('<html class="dark" lang="en">')).toBe(
      '<html class="dark boot-has-wordmark" lang="en">',
    );
    expect(applyMunimBootWordmarkClass('<html class="boot-has-wordmark" lang="en">')).toBe(
      '<html class="boot-has-wordmark" lang="en">',
    );
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });
});
