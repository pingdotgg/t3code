import type { EnvironmentId } from "@t3tools/contracts";
import type { UsageContractMismatch } from "@t3tools/shared/usageMerge";

export function usageAvailability(
  environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly summary: unknown;
    readonly error?: string | null;
    readonly isConnected?: boolean;
  }[],
  mismatches: readonly UsageContractMismatch[],
) {
  const incompatibleIds = new Set(mismatches.map(({ environmentId }) => environmentId));
  const hasCompatibleSummary = environments.some(
    ({ environmentId, summary }) => summary != null && !incompatibleIds.has(environmentId),
  );
  const notices = environments.flatMap((environment) => {
    const { environmentId, label, summary, error, isConnected } = environment;
    const mismatch = mismatches.find((entry) => entry.environmentId === environmentId);
    let message: string;
    if (mismatch) {
      message =
        mismatch.direction === "clientBehind"
          ? `Update this app to see usage from ${label}. Its server uses a newer usage format.`
          : `Update the T3 Code server on ${label} to see its usage. Its usage format is too old for this app.`;
    } else if (isConnected === false) {
      message =
        summary != null
          ? `${label} is disconnected. Showing saved usage, which may be out of date.`
          : `Connect to ${label} to load its usage.`;
    } else if (error) {
      message =
        summary != null
          ? `Could not refresh usage from ${label}. Showing saved usage, which may be out of date.`
          : `Could not load usage from ${label}. Try again.`;
    } else if (summary == null) {
      message = `Waiting for usage from ${label}.`;
    } else {
      return [];
    }
    return [{ environmentId, message }];
  });
  const excluded = environments.some(
    ({ environmentId, summary }) => summary == null || incompatibleIds.has(environmentId),
  );
  return {
    hasCompatibleSummary,
    notices,
    canRetry: environments.some(
      ({ error, isConnected }) => Boolean(error) && isConnected !== false,
    ),
    coverageMessage: hasCompatibleSummary
      ? excluded
        ? "Totals below exclude unavailable environments."
        : "Totals below include saved usage."
      : mismatches.length > 0
        ? "Usage cannot be displayed until a compatible environment reports usage."
        : "No usage totals are available yet. This does not mean there was no activity.",
  };
}
