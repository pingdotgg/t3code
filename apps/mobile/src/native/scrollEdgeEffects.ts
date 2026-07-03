// Pure helpers for native header scroll-edge effects. Kept free of
// react-native / react-navigation imports so they stay unit-testable in node
// (those packages ship untranspiled Flow syntax).

export type NativeTopScrollEdgeEffect = "automatic" | "soft";
export type NativeHeaderScrollEdgeEffects = {
  readonly top: NativeTopScrollEdgeEffect;
  readonly bottom: "hidden";
  readonly left: "hidden";
  readonly right: "hidden";
};

export function nativeTopScrollEdgeEffect(
  os: string,
  _version: number | string,
): NativeTopScrollEdgeEffect {
  if (os !== "ios") {
    return "automatic";
  }

  // The standalone RNS/Mail spike that matched Messages/GitHub used UIKit's
  // automatic scroll-edge behavior. Forcing `soft` on iOS 27 makes production
  // look like a local overlay instead of sampling the app content edge-to-edge.
  return "automatic";
}

export function nativeHeaderScrollEdgeEffects(
  os: string,
  version: number | string,
): NativeHeaderScrollEdgeEffects {
  return {
    top: nativeTopScrollEdgeEffect(os, version),
    bottom: "hidden",
    left: "hidden",
    right: "hidden",
  };
}
