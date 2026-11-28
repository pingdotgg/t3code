import {
  ProviderSetupError,
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { brokenVersionDetail } from "@t3tools/provider-core/server/compatibility";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

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
const compilePattern = (pattern: string) => {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
};
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  /** Matches a reported version that is not plain `X.Y.Z`; its first group is the version to rate. */
  versionPattern: Schema.optionalKey(
    TrimmedNonEmptyString.pipe(
      Schema.check(Schema.makeFilter((value) => compilePattern(value) !== undefined)),
    ),
  ),
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
  // Without a pattern, build hashes, revisions and prereleases stay unknown.
  const pattern = policy.versionPattern ? compilePattern(policy.versionPattern) : undefined;
  const stable = (pattern && unprefixed?.match(pattern)?.[1]) || unprefixed;
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

/** The one refusal for a runtime the policy rates `broken`; `action` names how this runtime is updated. */
export function brokenRuntimeError(input: {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly version: string;
  readonly advisory: ServerProviderCompatibilityAdvisory | undefined;
  readonly action?: string;
}): ProviderSetupError | undefined {
  const detail = brokenVersionDetail(input);
  return detail === undefined
    ? undefined
    : new ProviderSetupError({ instanceId: input.instanceId, operation: "runtime", detail });
}

export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const resolve = (version: string | null) =>
    resolveProviderCompatibility(policies, snapshot.driver, version) ??
    resolveProviderCompatibility(fallback, snapshot.driver, version);
  const advisory = resolve(snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion ? resolve(latestVersion) : undefined;
  const updateCommand = snapshot.versionAdvisory?.updateCommand;
  // The maintenance resolver emits this command only for confirmed Homebrew installs.
  const needsHomebrewRefresh =
    updateCommand?.startsWith("brew upgrade ") &&
    (advisory?.status === "unsupported" || advisory?.status === "broken") &&
    (latestAdvisory?.status === "unsupported" || latestAdvisory?.status === "broken");
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          message: needsHomebrewRefresh
            ? `${advisory.message} Homebrew's local package metadata may be stale. Run brew update && ${updateCommand} on this environment's host, then refresh provider status.`
            : advisory.message,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      }
    : base;
}
