import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";
import { readPngDimensions } from "./icon-export.ts";

describe("brand-assets", () => {
  it("ships a Chrome-installable web app manifest", () => {
    const publicDirectory = new URL("../../apps/web/public/", import.meta.url);
    const manifest = JSON.parse(
      readFileSync(new URL("manifest.webmanifest", publicDirectory), "utf8"),
    ) as {
      readonly name?: unknown;
      readonly short_name?: unknown;
      readonly start_url?: unknown;
      readonly display?: unknown;
      readonly icons?: ReadonlyArray<{ readonly src?: unknown; readonly sizes?: unknown }>;
    };

    expect(manifest).toMatchObject({
      name: "T3 Code",
      short_name: "T3 Code",
      start_url: "/",
      display: "standalone",
      icons: [
        { src: "/web-app-icon-192.png", sizes: "192x192" },
        { src: "/web-app-icon-512.png", sizes: "512x512" },
      ],
    });
    expect(
      manifest.icons?.map(({ src, sizes }) => {
        expect(typeof src).toBe("string");
        const image = readFileSync(new URL(String(src).replace(/^\//, ""), publicDirectory));
        return [sizes, readPngDimensions(image)];
      }),
    ).toEqual([
      ["192x192", { width: 192, height: 192 }],
      ["512x512", { width: 512, height: 512 }],
    ]);
  });

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
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppIcon192Png,
        targetRelativePath: "dist/client/web-app-icon-192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppIcon512Png,
        targetRelativePath: "dist/client/web-app-icon-512.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps development web assets to the public splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppIcon192Png,
        targetRelativePath: "apps/web/public/web-app-icon-192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppIcon512Png,
        targetRelativePath: "apps/web/public/web-app-icon-512.png",
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

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("maps package versions to web asset brands", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("nightly");
  });

  it("keeps development, nightly, and production icon families separate", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/dev/app-icon.icon",
      "assets/nightly/app-icon.icon",
      "assets/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/dev\/blueprint-/);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/nightly\/nightly-/);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/prod\/black-/);
  });
});
