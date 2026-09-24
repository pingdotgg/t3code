import type { DevicePlatform } from "@t3tools/contracts";

export interface DeviceShapeProfile {
  readonly id: "ios-phone" | "ios-tablet" | "android-phone" | "android-tablet";
  readonly bezel: number;
  readonly bodyRadius: number;
  readonly screenRadius: number;
  readonly depth: number;
  readonly backColor: number;
  readonly buttons: ReadonlyArray<{
    readonly edge: "left" | "right" | "top";
    readonly offset: number;
    readonly length: number;
  }>;
  readonly camera: {
    readonly width: number;
    readonly height: number;
    readonly insetX: number;
    readonly insetY: number;
    readonly lensRadius: number;
    readonly lenses: ReadonlyArray<readonly [number, number]>;
    readonly flash: readonly [number, number] | null;
  };
}

/** Original family silhouettes, rather than claims to reproduce individual hardware models. */
export const IOS_PHONE_SHAPE: DeviceShapeProfile = {
  id: "ios-phone",
  bezel: 0.055,
  bodyRadius: 0.15,
  screenRadius: 0.105,
  depth: 0.085,
  backColor: 0x424b5d,
  buttons: [
    { edge: "right", offset: 0.35, length: 0.3 },
    { edge: "left", offset: 0.48, length: 0.18 },
    { edge: "left", offset: 0.22, length: 0.18 },
  ],
  camera: {
    width: 0.39,
    height: 0.44,
    insetX: 0.25,
    insetY: 0.29,
    lensRadius: 0.068,
    lenses: [
      [-0.08, 0.095],
      [0.08, -0.095],
    ],
    flash: [0.085, 0.11],
  },
};

export const IOS_TABLET_SHAPE: DeviceShapeProfile = {
  id: "ios-tablet",
  bezel: 0.065,
  bodyRadius: 0.105,
  screenRadius: 0.045,
  depth: 0.055,
  backColor: 0x9ca5af,
  buttons: [
    { edge: "top", offset: 0.5, length: 0.15 },
    { edge: "right", offset: 0.78, length: 0.13 },
    { edge: "right", offset: 0.58, length: 0.13 },
  ],
  camera: {
    width: 0.19,
    height: 0.19,
    insetX: 0.15,
    insetY: 0.15,
    lensRadius: 0.045,
    lenses: [[0, 0]],
    flash: null,
  },
};

export const ANDROID_PHONE_SHAPE: DeviceShapeProfile = {
  id: "android-phone",
  bezel: 0.035,
  bodyRadius: 0.115,
  screenRadius: 0.08,
  depth: 0.085,
  backColor: 0x344449,
  buttons: [
    { edge: "right", offset: 0.2, length: 0.24 },
    { edge: "right", offset: 0.65, length: 0.32 },
  ],
  camera: {
    width: 0.24,
    height: 0.47,
    insetX: 0.18,
    insetY: 0.29,
    lensRadius: 0.056,
    lenses: [
      [0, 0.11],
      [0, -0.11],
    ],
    flash: [0.1, 0],
  },
};

const ANDROID_TABLET_SHAPE: DeviceShapeProfile = {
  ...IOS_TABLET_SHAPE,
  id: "android-tablet",
  backColor: 0x697b80,
};

/** Names identify a family when available; wide unknown screens get a generic tablet shell. */
export function resolveDeviceShape(options: {
  platform: DevicePlatform;
  name?: string;
  portraitAspect: number;
}): DeviceShapeProfile {
  const name = options.name ?? "";
  const namedTablet = /\b(ipad|tablet)\b/i.test(name);
  const namedPhone = /\b(iphone|phone)\b/i.test(name);
  const tablet = namedTablet || (!namedPhone && options.portraitAspect >= 0.6);
  return options.platform === "ios"
    ? tablet
      ? IOS_TABLET_SHAPE
      : IOS_PHONE_SHAPE
    : tablet
      ? ANDROID_TABLET_SHAPE
      : ANDROID_PHONE_SHAPE;
}
