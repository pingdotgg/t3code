export const BRAND_ASSET_PATHS = {
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

  munimIconComposerProject: "assets/munim/app-icon.icon",
  munimIosIconPng: "assets/munim/munim-icon-dark-1024.png",
  munimIosIconLightPng: "assets/munim/munim-icon-light-1024.png",
  munimMacIconPng: "assets/munim/munim-macos-1024.png",
  munimWebFaviconIco: "assets/munim/munim-web-favicon.ico",
  munimWebFavicon16Png: "assets/munim/munim-web-favicon-16x16.png",
  munimWebFavicon32Png: "assets/munim/munim-web-favicon-32x32.png",
  munimWebAppleTouchIconPng: "assets/munim/munim-web-apple-touch-180.png",
  munimWebIcon192Png: "assets/munim/munim-web-icon-192x192.png",
  munimWebIcon512Png: "assets/munim/munim-web-icon-512x512.png",
  munimWebWordmarkPng: "assets/munim/munim-web-wordmark.png",
  munimLinuxIconPng: "assets/munim/munim-universal-1024.png",
  munimUniversalIconPng: "assets/munim/munim-universal-1024.png",
  munimWindowsIconIco: "assets/munim/munim-windows.ico",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
  developmentWebIcon192Png: "assets/dev/blueprint-web-icon-192x192.png",
  developmentWebIcon512Png: "assets/dev/blueprint-web-icon-512x512.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production" | "munim";

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
  munim: {
    faviconIco: BRAND_ASSET_PATHS.munimWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.munimWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.munimWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.munimWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.munimWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.munimWebIcon512Png,
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
    // Only the Munim brand ships a wordmark. The boot shell probes for this file
    // and falls back to the app icon when it is absent, so other brands are
    // unaffected by its absence.
    ...(brand === "munim"
      ? [
          {
            sourceRelativePath: BRAND_ASSET_PATHS.munimWebWordmarkPng,
            targetRelativePath: `${targetDirectory}/boot-wordmark.png`,
          },
        ]
      : []),
  ];
}

const BOOT_HAS_WORDMARK_CLASS = "boot-has-wordmark";

/**
 * Munim builds ship `boot-wordmark.png`. Stamp the class onto the boot HTML so
 * the splash shows that wordmark on first paint instead of waiting for a probe
 * image to load (or falling back to the app icon).
 */
export function applyMunimBootWordmarkClass(html: string): string {
  return html.replace(/<html\b([^>]*)>/, (full, attrs: string) => {
    const classMatch = /\sclass=(["'])([^"']*)\1/.exec(attrs);
    if (classMatch) {
      const classes = classMatch[2]?.split(/\s+/).filter(Boolean) ?? [];
      if (classes.includes(BOOT_HAS_WORDMARK_CLASS)) {
        return full;
      }
      const next = `${classes.join(" ")} ${BOOT_HAS_WORDMARK_CLASS}`.trim();
      return `<html${attrs.replace(classMatch[0], ` class=${classMatch[1]}${next}${classMatch[1]}`)}>`;
    }
    return `<html class="${BOOT_HAS_WORDMARK_CLASS}"${attrs}>`;
  });
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
