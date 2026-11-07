import type { DevicePlatform } from "@t3tools/contracts";

export interface DeviceShapeProfile {
  readonly id:
    | "ios-phone"
    | "ios-tablet"
    | "android-phone"
    | "android-tablet"
    | "round-watch"
    | "square-watch";
  /** A circular case and display, sized from the shorter screen side. */
  readonly round?: true;
  readonly bezel: number;
  readonly bodyRadius: number;
  readonly screenRadius: number;
  readonly depth: number;
  readonly backColor: number;
  readonly buttons: ReadonlyArray<{
    readonly edge: "left" | "right" | "top";
    readonly offset: number;
    readonly length: number;
    /** A cylindrical key or crown that sticks out this far, instead of a flat key. */
    readonly crown?: number;
  }>;
  /** Strap lugs in pairs at the top and bottom of a round case, `span` apart at their outer edges. */
  readonly lugs?: { readonly span: number; readonly width: number; readonly length: number };
  readonly camera: {
    readonly width: number;
    readonly height: number;
    readonly insetX: number;
    readonly insetY: number;
    readonly lensRadius: number;
    readonly lenses: ReadonlyArray<readonly [number, number]>;
    readonly flash: readonly [number, number] | null;
  } | null;
}

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

export const ROUND_WATCH_SHAPE: DeviceShapeProfile = {
  id: "round-watch",
  round: true,
  bezel: 0.11,
  bodyRadius: 0,
  screenRadius: 0,
  depth: 0.6,
  backColor: 0x2b2f33,
  // Home and back keys at about two and four o'clock.
  buttons: [
    { edge: "right", offset: 0.58, length: 0.2, crown: 0.12 },
    { edge: "right", offset: -0.58, length: 0.2, crown: 0.12 },
  ],
  lugs: { span: 1.3, width: 0.17, length: 0.3 },
  camera: null,
};

export const SQUARE_WATCH_SHAPE: DeviceShapeProfile = {
  id: "square-watch",
  bezel: 0.13,
  bodyRadius: 0.6,
  screenRadius: 0.46,
  depth: 0.45,
  backColor: 0x1d2024,
  buttons: [
    { edge: "right", offset: 0.5, length: 0.32, crown: 0.09 },
    { edge: "right", offset: -0.25, length: 0.5 },
  ],
  camera: null,
};

// Wear OS Galaxy Watch model numbers only; nearby SM-R ranges are Galaxy Buds.
const SAMSUNG_WATCH_MODEL = /\bSM-(?:R(?:8[6-9]|9\d)\d|L[3-7]\d\d)[A-Z0-9]*\b/i;

export function resolveDeviceShape(options: {
  platform: DevicePlatform;
  name?: string;
  portraitAspect: number;
}): DeviceShapeProfile {
  const name = (options.name ?? "").replaceAll("_", " ");
  if (/\b(watch\d*|wear ?os)\b/i.test(name) || SAMSUNG_WATCH_MODEL.test(name)) {
    return options.platform === "ios" || /\b(square|rect(angular)?)\b/i.test(name)
      ? SQUARE_WATCH_SHAPE
      : ROUND_WATCH_SHAPE;
  }
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
