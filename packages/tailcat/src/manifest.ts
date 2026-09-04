import { satisfiesSemverRange } from "@t3tools/shared/semver";

import manifestJson from "../../../native/tailcat/manifest.json" with { type: "json" };

/**
 * The pinned upstream Tailcat release. `native/tailcat/manifest.json` is the
 * single source of truth for the version and per-platform digests; this module
 * only adds the compatibility policy the runtime enforces before it trusts a
 * binary it did not stage itself (system installs, developer overrides).
 */
export const TAILCAT_PINNED_VERSION: string = manifestJson.version;

/**
 * Versions the runtime accepts. Tailcat makes no CLI stability promises, so the
 * range is deliberately narrow: same minor as the pinned release. A system
 * binary outside this range is reported as incompatible with an actionable
 * message instead of producing mysterious flag or output mismatches.
 */
export const TAILCAT_COMPATIBLE_RANGE = `^${manifestJson.version}`;

export type TailcatPlatformKey =
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64"
  | "win32-arm64"
  | "darwin-arm64"
  | "darwin-x64";

export function tailcatPlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): TailcatPlatformKey | undefined {
  if (architecture !== "arm64" && architecture !== "x64") {
    return undefined;
  }
  switch (platform) {
    case "linux":
      return `linux-${architecture}`;
    case "win32":
      return `win32-${architecture}`;
    case "darwin":
      return `darwin-${architecture}`;
    default:
      return undefined;
  }
}

export function tailcatExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "tailcat.exe" : "tailcat";
}

/** Normalizes `tailcat version` output (`v0.5.0`, `0.5.0`, `v0.5.0-dirty`). */
export function normalizeTailcatVersion(raw: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/u.exec(raw.trim());
  return match?.[1] ?? null;
}

export function isCompatibleTailcatVersion(version: string): boolean {
  return satisfiesSemverRange(version, TAILCAT_COMPATIBLE_RANGE);
}

export const tailcatManifest = manifestJson;
