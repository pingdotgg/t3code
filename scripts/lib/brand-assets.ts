import { isStandaloneBuild, loadRepoEnv } from "./public-config.ts";

const UPSTREAM_BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",
  productionWebIcon192Png: "assets/prod/t3-black-web-icon-192x192.png",
  productionWebIcon512Png: "assets/prod/t3-black-web-icon-512x512.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",
  nightlyWebIcon192Png: "assets/nightly/nightly-web-icon-192x192.png",
  nightlyWebIcon512Png: "assets/nightly/nightly-web-icon-512x512.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
  developmentWebIcon192Png: "assets/dev/blueprint-web-icon-192x192.png",
  developmentWebIcon512Png: "assets/dev/blueprint-web-icon-512x512.png",
} as const;

// Standalone (fork) builds ship one EasyDev set for production and nightly; development keeps
// the upstream artwork so tracked dev assets and apps/web/public never change.
const STANDALONE_BRAND_ASSET_PATHS = {
  productionIconComposerProject: "assets/easydev/app-icon.icon",
  productionIosIconPng: "assets/easydev/easydev-ios-1024.png",
  productionMacIconPng: "assets/easydev/easydev-macos-1024.png",
  productionLinuxIconPng: "assets/easydev/easydev-universal-1024.png",
  productionWindowsIconIco: "assets/easydev/easydev-windows.ico",
  productionWebFaviconIco: "assets/easydev/easydev-web-favicon.ico",
  productionWebFavicon16Png: "assets/easydev/easydev-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/easydev/easydev-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/easydev/easydev-web-apple-touch-180.png",
  productionWebIcon192Png: "assets/easydev/easydev-web-icon-192x192.png",
  productionWebIcon512Png: "assets/easydev/easydev-web-icon-512x512.png",

  nightlyIconComposerProject: "assets/easydev/app-icon.icon",
  nightlyIosIconPng: "assets/easydev/easydev-ios-1024.png",
  nightlyMacIconPng: "assets/easydev/easydev-macos-1024.png",
  nightlyLinuxIconPng: "assets/easydev/easydev-universal-1024.png",
  nightlyWindowsIconIco: "assets/easydev/easydev-windows.ico",
  nightlyWebFaviconIco: "assets/easydev/easydev-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/easydev/easydev-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/easydev/easydev-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/easydev/easydev-web-apple-touch-180.png",
  nightlyWebIcon192Png: "assets/easydev/easydev-web-icon-192x192.png",
  nightlyWebIcon512Png: "assets/easydev/easydev-web-icon-512x512.png",
} as const satisfies Partial<Record<keyof typeof UPSTREAM_BRAND_ASSET_PATHS, string>>;

export const STANDALONE_DMG_BACKGROUND_SVG = "assets/easydev/dmg-background.svg";

export const STANDALONE_ANDROID_ASSETS = {
  adaptiveForeground: "assets/easydev/android-icon-foreground.png",
  adaptiveBackgroundImage: "assets/easydev/android-icon-background.png",
  adaptiveBackgroundColor: "#D4AF37",
  splashIcon: "assets/easydev/android-splash-icon.png",
  monochromeIcon: "assets/easydev/android-icon-mark.png",
  notificationIcon: "assets/easydev/android-notification-icon.png",
  notificationColor: "#D4AF37",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveBrandAssetPaths(
  env: Environment,
): Record<keyof typeof UPSTREAM_BRAND_ASSET_PATHS, string> {
  return isStandaloneBuild(env)
    ? { ...UPSTREAM_BRAND_ASSET_PATHS, ...STANDALONE_BRAND_ASSET_PATHS }
    : UPSTREAM_BRAND_ASSET_PATHS;
}

// From the repo env, not process.env, so a T3CODE_STANDALONE set only in .env matches the app UI.
const REPO_ENV = loadRepoEnv();

export const BRAND_ASSET_PATHS = resolveBrandAssetPaths(REPO_ENV);

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  icon192Png: "icon-192x192.png",
  icon512Png: "icon-512x512.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.developmentWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.developmentWebIcon512Png,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.productionWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.productionWebIcon512Png,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    {
      sourceRelativePath: sourcePaths.icon192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.icon512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon512Png}`,
    },
  ];
}

// Upstream releases replace these at publish time; a standalone CLI build has no such step.
export const CLI_CLIENT_ICON_OVERRIDES = resolveWebIconOverrides(
  isStandaloneBuild(REPO_ENV) ? "production" : "development",
  "dist/client",
);

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
