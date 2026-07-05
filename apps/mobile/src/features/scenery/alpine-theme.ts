import type { StyleProp, ViewStyle } from "react-native";

/**
 * The non-photo half of the alpine identity, mirroring the mac app's
 * AlpineTheme: duotone gradient washes sampled from Dolomites conditions,
 * used wherever a photo hasn't loaded yet (or no Unsplash key is configured)
 * so the app degrades to the same palette instead of gray placeholders.
 */

/** Alpine moss — matches --color-accent in global.css (light). */
export const ALPINE_ACCENT = "#4c755c";

/**
 * Duotone washes: dawn limestone, glacier melt, high meadow, larch dusk,
 * scree, spruce shade. Top-leading → bottom-trailing gradient stops.
 */
export const ALPINE_WASHES: ReadonlyArray<readonly [string, string]> = [
  ["#edccb5", "#8f8c9e"],
  ["#bad9de", "#6b8fa3"],
  ["#b8cc94", "#5c8066"],
  ["#e3b882", "#786b80"],
  ["#d1cfc7", "#85898c"],
  ["#8ca88f", "#405752"],
];

/**
 * FNV-1a (32-bit) over UTF-8, reduced mod `count`. Deterministic across
 * launches, unlike anything derived from per-launch-seeded hashing. The mac
 * app uses the 64-bit variant; parity across devices is irrelevant because
 * assignments are per-device, so the cheaper 32-bit form is fine in JS.
 */
export function stableIndex(seed: string, count: number): number {
  if (count <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    // Iterate UTF-8 bytes so multi-byte characters hash consistently.
    const code = seed.charCodeAt(i);
    hash = fnvByte(hash, code & 0xff);
    if (code > 0xff) {
      hash = fnvByte(hash, (code >>> 8) & 0xff);
    }
  }
  return (hash >>> 0) % count;
}

function fnvByte(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, 0x01000193) >>> 0;
}

/** The wash pair a seed falls back to. */
export function washColors(seed: string): readonly [string, string] {
  return ALPINE_WASHES[stableIndex(seed, ALPINE_WASHES.length)]!;
}

/**
 * Deterministic duotone gradient for a seed (thread/photo id), as a style
 * object. Uses the CSS-gradient background already proven elsewhere in this
 * app (Fabric/new-arch only); if it ever regresses, swap the fallback to a
 * solid `averageColorHex` fill here, in one place.
 */
export function washGradientStyle(seed: string): StyleProp<ViewStyle> {
  const [from, to] = washColors(seed);
  return {
    experimental_backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
  };
}
