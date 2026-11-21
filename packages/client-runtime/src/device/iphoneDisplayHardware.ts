import type { DeviceScreenSize } from "./stream.ts";

type Notch = readonly [width: number, height: number, depth: number, leftEdge: readonly number[]];
type Hardware = {
  readonly notch: Notch;
  readonly cameraX: number;
  readonly sensorX: number;
  readonly centerY: number;
  readonly radius: number;
};

// Xcode's framebuffer masks, sampled down the left shoulder at these fractions of the notch depth.
const depths = [0, 0.02, 0.05, 0.12, 0.25, 0.45, 0.65, 0.8, 0.9, 0.96, 0.98, 1];
const notchX: Notch = [
  1125,
  2436,
  90,
  [214, 242, 246, 249, 250, 253, 260, 271, 284, 296, 306, 336],
];
const notchXsMax: Notch = [
  1242,
  2688,
  90,
  [284, 299, 302, 306, 307, 310, 317, 328, 341, 353, 361, 392],
];
const notchXr: Notch = [
  828,
  1792,
  66,
  [168, 177, 180, 183, 184, 186, 192, 201, 210, 220, 230, 245],
];
const notch12: Notch = [
  1170,
  2532,
  96,
  [245, 261, 265, 269, 270, 272, 279, 290, 302, 316, 324, 356],
];
const notch12Max: Notch = [
  1284,
  2778,
  96,
  [304, 319, 323, 327, 328, 330, 337, 348, 360, 374, 382, 413],
];
const notch12Mini: Notch = [
  1125,
  2436,
  103,
  [197, 213, 217, 222, 223, 225, 233, 245, 259, 273, 282, 315],
];
const notch13: Notch = [
  1170,
  2532,
  101,
  [318, 334, 338, 341, 342, 344, 351, 363, 376, 390, 398, 430],
];
const notch13Max: Notch = [
  1284,
  2778,
  101,
  [376, 392, 395, 399, 400, 402, 409, 420, 433, 447, 455, 487],
];
const notch13Mini: Notch = [
  1125,
  2436,
  112,
  [275, 292, 297, 300, 301, 303, 310, 323, 336, 352, 360, 389],
];

const legacyNotch = (notch: Notch): Hardware => ({
  notch,
  cameraX: 0.614,
  sensorX: 0.386,
  centerY: 0.019,
  radius: 0.016,
});

const compactNotch = (notch: Notch): Hardware => ({
  notch,
  cameraX: 0.407,
  sensorX: 0.582,
  centerY: 0.018,
  radius: 0.017,
});

const profiles: ReadonlyMap<string, Hardware> = new Map([
  ["x", legacyNotch(notchX)],
  ["xs", legacyNotch(notchX)],
  ["11 pro", legacyNotch(notchX)],
  ["xr", legacyNotch(notchXr)],
  ["11", legacyNotch(notchXr)],
  ["xs max", legacyNotch(notchXsMax)],
  ["11 pro max", legacyNotch(notchXsMax)],
  ["12", legacyNotch(notch12)],
  ["12 pro", legacyNotch(notch12)],
  ["12 mini", legacyNotch(notch12Mini)],
  ["12 pro max", legacyNotch(notch12Max)],
  ["13", compactNotch(notch13)],
  ["13 pro", compactNotch(notch13)],
  ["14", compactNotch(notch13)],
  ["16e", compactNotch(notch13)],
  ["17e", compactNotch(notch13)],
  ["13 mini", compactNotch(notch13Mini)],
  ["13 pro max", compactNotch(notch13Max)],
  ["14 plus", compactNotch(notch13Max)],
]);

export function iphoneDisplayHardware(name: string | undefined) {
  const model = /^iphone\s+(.+)$/iu
    .exec(name?.trim() ?? "")?.[1]
    ?.toLowerCase()
    .replace("ʀ", "r");
  return model ? profiles.get(model) : undefined;
}

const imageCache = new WeakMap<Hardware, HTMLCanvasElement>();

export function iphoneHardwareImage(hardware: Hardware) {
  const cached = imageCache.get(hardware);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  const width = 360;
  const height = 780;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  const [sourceWidth, sourceHeight, depth, leftEdge] = hardware.notch;
  const edge = leftEdge.map(
    (x, index) =>
      [(x / sourceWidth) * width, ((depths[index]! * depth) / sourceHeight) * height] as const,
  );
  context.beginPath();
  context.moveTo(edge[0]![0], 0);
  for (const [x, y] of edge) context.lineTo(x, y);
  for (const [x, y] of [...edge].reverse()) context.lineTo(width - x, y);
  context.closePath();
  context.fillStyle = "#000";
  context.fill();

  const y = hardware.centerY * height;
  const radius = hardware.radius * width;
  for (const [center, aperture, reflection] of [
    [hardware.cameraX, radius, "#2c4160"],
    [hardware.sensorX, radius * 0.7, "#25232e"],
  ] as const) {
    const x = center * width;
    const glass = context.createRadialGradient(
      x - aperture * 0.26,
      y - aperture * 0.22,
      0,
      x,
      y,
      aperture,
    );
    glass.addColorStop(0, reflection);
    glass.addColorStop(0.37, "#101420");
    glass.addColorStop(0.62, "#06080b");
    glass.addColorStop(0.8, "#16171a");
    glass.addColorStop(1, "#000");
    context.beginPath();
    context.arc(x, y, aperture, 0, Math.PI * 2);
    context.fillStyle = glass;
    context.fill();
  }

  imageCache.set(hardware, canvas);
  return canvas;
}

const orientations = {
  portrait: 0,
  landscape_left: 90,
  landscape_right: -90,
  portrait_upside_down: 180,
} as const;

const cssStyles = new WeakMap<Hardware, Map<number, ReturnType<typeof hardwareStyle>>>();

function hardwareStyle(hardware: Hardware, rotation: number) {
  const sideways = Math.abs(rotation) === 90;
  return {
    width: sideways ? "100cqh" : "100%",
    height: sideways ? "100cqw" : "100%",
    backgroundImage: `url("${iphoneHardwareImage(hardware).toDataURL()}")`,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  } as const;
}

export function iphoneHardwareOverlayStyle(hardware: Hardware, screen: DeviceScreenSize | null) {
  const rotation = orientations[screen?.orientation ?? "portrait"];
  const styles = cssStyles.get(hardware) ?? new Map();
  const style = styles.get(rotation) ?? hardwareStyle(hardware, rotation);
  styles.set(rotation, style);
  cssStyles.set(hardware, styles);
  return style;
}

export function iphoneHardwareStyle(hardware: Hardware, screen: DeviceScreenSize | null) {
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    backgroundSize: "100% 100%",
    pointerEvents: "none",
    ...iphoneHardwareOverlayStyle(hardware, screen),
  } as const;
}
