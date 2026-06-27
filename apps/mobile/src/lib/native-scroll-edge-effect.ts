export type NativeTopScrollEdgeEffect = "automatic" | "hard";

function majorVersion(version: number | string): number {
  if (typeof version === "number") {
    return Math.trunc(version);
  }

  const parsed = Number.parseInt(version, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * iOS 27 beta currently renders the automatic/soft top scroll-edge effect as
 * fully transparent. Keep the subtler automatic treatment on iOS 26 and use
 * UIKit's native hard treatment on iOS 27+ until the platform regression is
 * resolved.
 */
export function nativeTopScrollEdgeEffect(
  os: string,
  version: number | string,
): NativeTopScrollEdgeEffect {
  return os === "ios" && majorVersion(version) >= 27 ? "hard" : "automatic";
}
