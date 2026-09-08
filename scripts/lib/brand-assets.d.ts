export declare const BRAND_ASSET_PATHS: {
  readonly developmentIconComposerProject: "assets/dev/app-icon.icon";
  readonly developmentIosIconPng: "assets/dev/blueprint-ios-1024.png";
  readonly developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png";
  readonly productionIconComposerProject: "assets/prod/app-icon.icon";
  readonly productionIosIconPng: "assets/prod/black-ios-1024.png";
  readonly productionMacIconPng: "assets/prod/black-macos-1024.png";
  readonly productionLinuxIconPng: "assets/prod/black-universal-1024.png";
  readonly productionWindowsIconIco: "assets/prod/t3-black-windows.ico";
  readonly productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico";
  readonly productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png";
  readonly productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png";
  readonly productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png";
  readonly nightlyIconComposerProject: "assets/nightly/app-icon.icon";
  readonly nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png";
  readonly nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png";
  readonly nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png";
  readonly nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico";
  readonly nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico";
  readonly nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png";
  readonly nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png";
  readonly nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png";
  readonly developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png";
  readonly developmentWindowsIconIco: "assets/dev/blueprint-windows.ico";
  readonly developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico";
  readonly developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png";
  readonly developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png";
  readonly developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png";
};
export type WebAssetBrand = "development" | "nightly" | "production";
export declare const WEB_ASSET_CHANNELS: readonly ["latest", "nightly"];
export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];
export declare function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand;
export declare function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand;
export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}
export declare function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride>;
export declare const DEVELOPMENT_ICON_OVERRIDES: readonly IconOverride[];
export declare const DEVELOPMENT_PUBLIC_ICON_OVERRIDES: readonly IconOverride[];
