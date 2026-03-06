export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/macos-icon-1024.png",
  // Keep Linux explicit so it can diverge from macOS branding later.
  productionLinuxIconPng: "assets/macos-icon-1024.png",
  productionWindowsIconIco: "assets/windows-icon.ico",
} as const;

export interface PublishIconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<PublishIconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWindowsIconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
];
