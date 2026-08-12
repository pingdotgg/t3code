import type {
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";

export type PullRequestStateKind = "merged" | "closed" | "draft" | "conflicting" | "open";

export interface PullRequestStatePresentation {
  readonly kind: PullRequestStateKind;
  readonly label: string;
  readonly symbol:
    | "point.topleft.down.curvedto.point.bottomright.up"
    | "xmark"
    | "doc.text"
    | "exclamationmark.triangle"
    | "arrow.triangle.pull";
  readonly textClassName: string;
  readonly badgeClassName: string;
}

/**
 * How a pull request's state reads on this surface. Open, closed and merged use the same
 * colours as the thread list PR badge; draft and conflicts are states that badge never shows.
 */
export function resolvePullRequestState(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
  readonly baseBranch?: string;
}): PullRequestStatePresentation {
  if (input.state === "merged") {
    return {
      kind: "merged",
      label: "Merged",
      symbol: "point.topleft.down.curvedto.point.bottomright.up",
      textClassName: "text-violet-600 dark:text-violet-400",
      badgeClassName: "bg-violet-500/15",
    };
  }
  if (input.state === "closed") {
    return {
      kind: "closed",
      label: "Closed",
      symbol: "xmark",
      textClassName: "text-red-600 dark:text-red-400",
      badgeClassName: "bg-red-500/15",
    };
  }
  if (input.isDraft) {
    return {
      kind: "draft",
      label: "Draft",
      symbol: "doc.text",
      textClassName: "text-zinc-500 dark:text-zinc-400",
      badgeClassName: "bg-zinc-500/15",
    };
  }
  if (input.mergeability === "conflicting") {
    return {
      kind: "conflicting",
      label: input.baseBranch ? `Conflicts with ${input.baseBranch}` : "Has conflicts",
      symbol: "exclamationmark.triangle",
      textClassName: "text-danger-foreground",
      badgeClassName: "bg-danger",
    };
  }
  return {
    kind: "open",
    label: "Open",
    symbol: "arrow.triangle.pull",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    badgeClassName: "bg-emerald-500/15",
  };
}

export function summarizePullRequestChecks(checks: ReadonlyArray<PullRequestCheck>): string {
  if (checks.length === 0) return "No checks reported";
  const failed = checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  ).length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passed = checks.filter((check) => check.status === "success").length;
  if (failed > 0) return `${failed} of ${checks.length} failing`;
  if (pending > 0) return `${pending} of ${checks.length} running`;
  return passed === checks.length ? "All checks passed" : `${passed} of ${checks.length} passing`;
}

export function pullRequestCheckStatusLabel(status: PullRequestCheckStatus): string {
  switch (status) {
    case "pending":
      return "Running";
    case "success":
      return "Passed";
    case "failure":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "neutral":
      return "Neutral";
    case "cancelled":
      return "Cancelled";
  }
}

export function pullRequestCheckSymbol(
  status: PullRequestCheckStatus,
): "clock" | "checkmark.circle" | "xmark.circle.fill" | "minus.circle" {
  switch (status) {
    case "pending":
      return "clock";
    case "success":
      return "checkmark.circle";
    case "failure":
    case "cancelled":
      return "xmark.circle.fill";
    case "skipped":
    case "neutral":
      return "minus.circle";
  }
}

export function formatDiffStat(additions: number, deletions: number): string | null {
  if (additions === 0 && deletions === 0) return null;
  return `+${additions.toLocaleString()} −${deletions.toLocaleString()}`;
}
