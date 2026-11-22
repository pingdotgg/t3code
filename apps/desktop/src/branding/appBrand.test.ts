import { describe, expect, it } from "vite-plus/test";

import {
  UPSTREAM_APP_BRAND,
  appBrand,
  appBrandDisplayName,
  appBrandHandledSchemes,
  appBrandPreviousScheme,
  appBrandRewritePreviousScheme,
  resolveAppBrand,
} from "./appBrand.ts";
import { FORK_BRAND_SOURCE, resolveForkBrand } from "./forkBrand.ts";

describe("app brand", () => {
  it("is upstream's identity when nothing is set", () => {
    expect(resolveAppBrand(undefined, {})).toEqual(UPSTREAM_APP_BRAND);
    expect(resolveAppBrand({}, {})).toEqual(UPSTREAM_APP_BRAND);
    // Code that is not the desktop bundle never sees the fork's values.
    expect(appBrand).toEqual(UPSTREAM_APP_BRAND);
    expect(appBrandDisplayName(UPSTREAM_APP_BRAND, "Alpha")).toBe("T3 Code (Alpha)");
    expect(appBrandDisplayName(UPSTREAM_APP_BRAND, "Dev")).toBe("T3 Code (Dev)");
  });

  it("derives the dev values, user-data folders and the previous identity from the fork's", () => {
    const brand = resolveForkBrand({});
    expect(brand).toEqual({
      name: "Conn",
      appId: "com.nckrtl.conn",
      devAppId: "com.nckrtl.conn.dev",
      scheme: "conn",
      devScheme: "conn-dev",
      userDataDirName: "conn",
      devUserDataDirName: "conn-dev",
      appleTeamId: "9SVJ4SYB9B",
      omitStageLabel: "Beta",
      icons: {
        dev: {
          macPng: "assets/conn/dev/conn-dev-macos-1024.png",
          universalPng: "assets/conn/dev/conn-dev-universal-1024.png",
          windowsIco: "assets/conn/dev/conn-dev-windows.ico",
          appleTouchPng: "assets/conn/dev/conn-dev-web-apple-touch-180.png",
          webFaviconIco: "assets/conn/dev/conn-dev-web-favicon.ico",
          webFavicon16Png: "assets/conn/dev/conn-dev-web-favicon-16x16.png",
          webFavicon32Png: "assets/conn/dev/conn-dev-web-favicon-32x32.png",
          webIcon192Png: "assets/conn/dev/conn-dev-web-icon-192x192.png",
          webIcon512Png: "assets/conn/dev/conn-dev-web-icon-512x512.png",
        },
        prod: {
          macPng: "assets/conn/prod/conn-prod-macos-1024.png",
          universalPng: "assets/conn/prod/conn-prod-universal-1024.png",
          windowsIco: "assets/conn/prod/conn-prod-windows.ico",
          appleTouchPng: "assets/conn/prod/conn-prod-web-apple-touch-180.png",
          webFaviconIco: "assets/conn/prod/conn-prod-web-favicon.ico",
          webFavicon16Png: "assets/conn/prod/conn-prod-web-favicon-16x16.png",
          webFavicon32Png: "assets/conn/prod/conn-prod-web-favicon-32x32.png",
          webIcon192Png: "assets/conn/prod/conn-prod-web-icon-192x192.png",
          webIcon512Png: "assets/conn/prod/conn-prod-web-icon-512x512.png",
        },
      },
      previous: {
        scheme: "t3code",
        devScheme: "t3code-dev",
        userDataDirName: "t3code",
        devUserDataDirName: "t3code-dev",
      },
    });
    expect(FORK_BRAND_SOURCE.name).toBe("Conn");
  });

  it("keeps upstream's icon for a channel or file the fork does not replace", () => {
    const brand = resolveAppBrand({ icons: { dev: { macPng: "assets/x/dev.png" } } }, {});
    expect(brand.icons.dev).toEqual({
      ...UPSTREAM_APP_BRAND.icons.dev,
      macPng: "assets/x/dev.png",
    });
    expect(brand.icons.prod).toEqual(UPSTREAM_APP_BRAND.icons.prod);
  });

  it("names the packaged app without a stage label and the others with one", () => {
    const brand = resolveForkBrand({});
    expect(appBrandDisplayName(brand, "Beta")).toBe("Conn");
    expect(appBrandDisplayName(brand, "Dev")).toBe("Conn (Dev)");
    expect(appBrandDisplayName(brand, "Nightly")).toBe("Conn (Nightly)");
  });

  it("lets the environment replace single values", () => {
    const brand = resolveForkBrand({
      T3CODE_APP_NAME: " Link ",
      T3CODE_DESKTOP_APP_ID: "com.example.link",
      T3CODE_DESKTOP_SCHEME: "link",
      T3CODE_APPLE_TEAM_ID: "abcde12345",
    });
    expect(brand).toMatchObject({
      name: "Link",
      appId: "com.example.link",
      devAppId: "com.example.link.dev",
      scheme: "link",
      devScheme: "link-dev",
      userDataDirName: "link",
      appleTeamId: "ABCDE12345",
    });
  });

  it("has no previous identity when the scheme stays upstream's", () => {
    expect(resolveAppBrand({ name: "Renamed Only" }, {}).previous).toBeNull();
  });

  it("refuses values the OS would reject", () => {
    expect(() => resolveAppBrand(undefined, { T3CODE_DESKTOP_SCHEME: "My Scheme" })).toThrow(
      /link scheme/,
    );
    expect(() => resolveAppBrand(undefined, { T3CODE_DESKTOP_APP_ID: "conn" })).toThrow(/app id/);
    expect(() => resolveAppBrand(undefined, { T3CODE_APPLE_TEAM_ID: "short" })).toThrow(/team id/);
  });

  it("handles links in its own scheme and in the one it took over from", () => {
    const brand = resolveForkBrand({});
    expect(appBrandHandledSchemes(brand, false)).toEqual(["conn", "t3code"]);
    expect(appBrandHandledSchemes(brand, true)).toEqual(["conn-dev", "t3code-dev"]);
    expect(appBrandPreviousScheme(UPSTREAM_APP_BRAND, true)).toBeNull();
    expect(appBrandHandledSchemes(UPSTREAM_APP_BRAND, true)).toEqual(["t3code-dev"]);
  });

  it("moves a link from the previous scheme to its own, in the same channel", () => {
    const brand = resolveForkBrand({});
    expect(
      appBrandRewritePreviousScheme(brand, true, "t3code-dev://app/settings#codex-auth=x"),
    ).toBe("conn-dev://app/settings#codex-auth=x");
    expect(appBrandRewritePreviousScheme(brand, false, "t3code://app/welcome")).toBe(
      "conn://app/welcome",
    );
    // Another channel's link, an own-scheme link, and upstream's brand stay as they are.
    expect(appBrandRewritePreviousScheme(brand, false, "t3code-dev://app/x")).toBe(
      "t3code-dev://app/x",
    );
    expect(appBrandRewritePreviousScheme(brand, true, "conn-dev://app/x")).toBe("conn-dev://app/x");
    expect(appBrandRewritePreviousScheme(UPSTREAM_APP_BRAND, false, "t3code://app/x")).toBe(
      "t3code://app/x",
    );
  });
});
