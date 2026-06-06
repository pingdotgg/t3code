export const BRAND_ASSET_PATHS = {
  salchiIconPng: "assets/salchi/salchi-icon-1024.png",
  salchiIconIco: "assets/salchi/salchi-icon.ico",
  salchiWebFaviconIco: "assets/salchi/salchi-web-favicon.ico",
  salchiWebFavicon16Png: "assets/salchi/salchi-web-favicon-16x16.png",
  salchiWebFavicon32Png: "assets/salchi/salchi-web-favicon-32x32.png",
  salchiWebAppleTouchIconPng: "assets/salchi/salchi-web-apple-touch-180.png",
  salchiWebPwa192Png: "assets/salchi/salchi-web-pwa-192.png",
  salchiWebPwa512Png: "assets/salchi/salchi-web-pwa-512.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForConfiguredChannel(
  channel: string | null | undefined,
): WebAssetBrand {
  const normalizedChannel = channel?.trim().toLowerCase();
  return normalizedChannel === "nightly" ? "nightly" : "production";
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
  pwa192Png: "pwa-192.png",
  pwa512Png: "pwa-512.png",
} as const;

const SALCHI_WEB_ICON_SOURCE_PATHS = {
  faviconIco: BRAND_ASSET_PATHS.salchiWebFaviconIco,
  favicon16Png: BRAND_ASSET_PATHS.salchiWebFavicon16Png,
  favicon32Png: BRAND_ASSET_PATHS.salchiWebFavicon32Png,
  appleTouchIconPng: BRAND_ASSET_PATHS.salchiWebAppleTouchIconPng,
  pwa192Png: BRAND_ASSET_PATHS.salchiWebPwa192Png,
  pwa512Png: BRAND_ASSET_PATHS.salchiWebPwa512Png,
} as const satisfies Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: SALCHI_WEB_ICON_SOURCE_PATHS,
  nightly: SALCHI_WEB_ICON_SOURCE_PATHS,
  production: SALCHI_WEB_ICON_SOURCE_PATHS,
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
      sourceRelativePath: sourcePaths.pwa192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.pwa192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.pwa512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.pwa512Png}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const PUBLISH_ICON_OVERRIDES = resolveWebIconOverrides("production", "dist/client");
