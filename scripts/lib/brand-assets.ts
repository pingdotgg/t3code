export const BRAND_ASSET_PATHS = {
  productionIconPng: "assets/macos-icon-1024.png",
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
