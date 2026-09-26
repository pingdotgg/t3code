import {
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

// Deliberately uses the shared CLI gate syntax: comparator groups joined by ||.
// Prereleases and unrecognized release tags remain unknown.
const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ===
            "supported"
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  t3CodeVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const policy = policies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(t3CodeVersion, entry.t3CodeRange),
  );
  if (!policy) return undefined;
  const unprefixed = version?.replace(/^v/, "");
  // Cursor appends a build hash to its date; Google's ACP runtime uses a release prefix.
  // Strip only these driver-specific forms, keeping semver prereleases unknown.
  const stable =
    driver === "cursor"
      ? unprefixed?.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/, "$1")
      : driver === "antigravity"
        ? unprefixed?.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/, "$1")
        : unprefixed;
  const status =
    stable && /^\d+\.\d+\.\d+$/.test(stable)
      ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
        "unknown")
      : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this T3 Code release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this T3 Code release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this T3 Code release."
          : null;
  const recommendedVersion = policy.recommendedVersion ?? null;
  const recommendedRange = policy.recommendedRange ?? null;
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

/** A remote policy replaces its matching bundled policy; omission keeps the bundle. */
export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const advisory =
    resolveProviderCompatibility(policies, snapshot.driver, snapshot.version) ??
    resolveProviderCompatibility(fallback, snapshot.driver, snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion
    ? (resolveProviderCompatibility(policies, snapshot.driver, latestVersion) ??
      resolveProviderCompatibility(fallback, snapshot.driver, latestVersion))
    : undefined;
  // Homebrew's resolver emits this canonical command only after verifying ownership.
  // `brew info` can keep reporting an incompatible release until metadata is refreshed.
  const needsHomebrewRefresh =
    snapshot.versionAdvisory?.updateCommand?.startsWith("brew upgrade ") &&
    (advisory?.status === "unsupported" || advisory?.status === "broken") &&
    (latestAdvisory?.status === "unsupported" || latestAdvisory?.status === "broken");
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          ...(needsHomebrewRefresh
            ? {
                message: `${advisory.message} Homebrew's local package metadata may be stale. Run brew update on this environment's host, then refresh provider status to check for updates.`,
              }
            : {}),
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      }
    : base;
}
