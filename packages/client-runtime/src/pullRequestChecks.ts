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
  return newer
    ? {
        ...detail,
        state: detail.state === "merged" ? "merged" : checks.state,
        checks: checks.checks,
      }
    : detail;
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
