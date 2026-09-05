export function supportsNativeLiquidGlass(
  platform: string,
  nativeCapabilityAvailable: boolean,
): boolean {
  return platform === "ios" && nativeCapabilityAvailable;
}
