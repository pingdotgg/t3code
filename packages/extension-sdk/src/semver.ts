// Plain `X.Y.Z` versions and the few range shapes packs write, for the SDK's
// API version guard. Not a package export: bundled into packs, so it stays
// small instead of pulling in the runtime's `semver` dependency. Anything
// else (prereleases, build metadata, x-ranges, `||`, hyphens, partials,
// components above Number.MAX_SAFE_INTEGER) has no floor, so the guard refuses.

const TRIPLE = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const VERSION = new RegExp(`^${TRIPLE}$`);
const RANGE = new RegExp(`^(?:\\^|~|>=)?${TRIPLE}$`);
const BOUNDED = new RegExp(`^>=${TRIPLE} <${TRIPLE}$`);

export type Version = readonly [number, number, number];

function toVersion(parts: readonly string[]): Version | null {
  const [major, minor, patch] = parts.map(Number) as [number, number, number];
  return [major, minor, patch].every(Number.isSafeInteger) ? [major, minor, patch] : null;
}

/** A plain `X.Y.Z` version with safe-integer components, or null. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  return match ? toVersion(match.slice(1, 4)) : null;
}

/** Negative, zero or positive as `a` sorts before, with or after `b`. */
export function compareVersions(a: Version, b: Version): number {
  return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/**
 * The lowest version admitted by `X.Y.Z`, `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` or
 * `>=X.Y.Z <A.B.C`; null for any other shape or an empty range.
 */
export function rangeFloor(range: string): Version | null {
  const match = RANGE.exec(range);
  if (match) return toVersion(match.slice(1, 4));
  const bounded = BOUNDED.exec(range);
  if (!bounded) return null;
  const floor = toVersion(bounded.slice(1, 4));
  const ceiling = toVersion(bounded.slice(4, 7));
  return floor && ceiling && compareVersions(floor, ceiling) < 0 ? floor : null;
}
