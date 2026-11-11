export type MobilePlatform = "ios" | "android";

export type MobileSourceMapKind = "ota" | "build";

/** The relay's R2 key for a bundle's source map: an OTA update's, or an EAS build's embedded one. */
export const mobileSourceMapKey = (
  platform: MobilePlatform,
  kind: MobileSourceMapKind,
  id: string,
) => `${platform}/${kind}/${id}.map`;
