const FULL_SEMVER =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMPARABLE_SEMVER =
  /^(?:v)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedSemver {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: ReadonlyArray<string>;
}

function hasValidPrerelease(value: string): boolean {
  const prerelease = value.match(/^[^-+]+(?:-(?<prerelease>[^+]+))?(?:\+|$)/)?.groups?.prerelease;
  return (
    prerelease === undefined ||
    prerelease
      .split(".")
      .every((identifier) => !/^\d+$/.test(identifier) || /^(?:0|[1-9]\d*)$/.test(identifier))
  );
}

export function normalizeMaintenanceVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !FULL_SEMVER.test(trimmed) || !hasValidPrerelease(trimmed)) return null;
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function parse(value: string): ParsedSemver | null {
  const match = hasValidPrerelease(value) ? COMPARABLE_SEMVER.exec(value) : null;
  return match
    ? {
        major: BigInt(match[1]!),
        minor: BigInt(match[2] ?? 0),
        patch: BigInt(match[3] ?? 0),
        prerelease: match[4]?.split(".") ?? [],
      }
    : null;
}

function comparePrerelease(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareMaintenanceVersions(left: string, right: string): number | null {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}
