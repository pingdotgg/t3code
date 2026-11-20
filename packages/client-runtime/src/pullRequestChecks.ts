import type { PullRequestCheck, PullRequestChecks, PullRequestDetail } from "@t3tools/contracts";

export function resolvePullRequestDetailChecks(
  detail: PullRequestDetail | null,
  checks: PullRequestChecks | null,
  checksAreNewer: boolean,
): PullRequestDetail | null {
  if (detail === null || checks === null) return detail;
  const newer =
    detail.observedAt !== undefined && checks.observedAt !== undefined
      ? checks.observedAt >= detail.observedAt
      : checksAreNewer;
  if (!newer) return detail;
  // The checks read answered what the detail could not, so checks are no longer unavailable.
  const { unavailable, ...answered } = detail;
  const stillUnavailable = unavailable?.filter((part) => part !== "checks") ?? [];
  return {
    ...answered,
    ...(stillUnavailable.length === 0 ? {} : { unavailable: stillUnavailable }),
    state: detail.state === "merged" ? "merged" : checks.state,
    checks: checks.checks,
  };
}

/** Checks still running are worth a tighter poll than a settled head. */
export function pullRequestChecksRefreshIntervalMs(
  checks: ReadonlyArray<PullRequestCheck>,
): number {
  return checks.length === 0 ||
    checks.some((check) => check.status === "pending" || check.status === "action-required")
    ? 45_000
    : 60_000;
}
