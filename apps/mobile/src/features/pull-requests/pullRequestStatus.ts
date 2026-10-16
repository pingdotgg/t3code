import type {
  PullRequestActivity,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestListEntry,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

const STATES = {
  open: {
    label: "Open",
    icon: "arrow.triangle.pull",
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
    background: "bg-adaptive-emerald-500-a12-a16",
  },
  merged: {
    label: "Merged",
    icon: "arrow.triangle.merge",
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
    background: "bg-adaptive-violet-500-a12-a16",
  },
  closed: {
    label: "Closed",
    icon: "git.pull-request.closed",
    tint: "accent-danger-foreground",
    text: "text-danger-foreground",
    background: "bg-danger",
  },
  draft: {
    label: "Draft",
    icon: "git.pull-request.draft",
    tint: "accent-icon-muted",
    text: "text-foreground-muted",
    background: "bg-grouped-card",
  },
} satisfies Record<
  string,
  { label: string; icon: AppSymbolName; tint: string; text: string; background: string }
>;

export function pullRequestStatus(pr: Pick<PullRequestListEntry, "state" | "isDraft">) {
  return STATES[pr.isDraft && pr.state === "open" ? "draft" : pr.state];
}

export function checkStatus(check: PullRequestCheck) {
  switch (check.status) {
    case "success":
      return {
        label: "Passed",
        icon: "checkmark.circle",
        tint: "accent-adaptive-emerald-600-400",
      } as const;
    case "failure":
      return {
        label: "Failed",
        icon: "exclamationmark.circle",
        tint: "accent-danger-foreground",
      } as const;
    case "action-required":
      return {
        label: "Action required",
        icon: "exclamationmark.circle",
        tint: "accent-warning-foreground",
      } as const;
    case "pending":
      return { label: "Pending", icon: "clock", tint: "accent-warning-foreground" } as const;
    case "cancelled":
      return { label: "Cancelled", icon: "minus", tint: "accent-icon-muted" } as const;
    case "skipped":
      return { label: "Skipped", icon: "minus", tint: "accent-icon-muted" } as const;
    case "neutral":
      return { label: "Neutral", icon: "minus", tint: "accent-icon-muted" } as const;
  }
}

export function pullRequestChecksSummary(pr: Pick<PullRequestDetail, "checks">) {
  const failed = pr.checks.filter((check) => check.status === "failure").length;
  const required = pr.checks.filter((check) => check.status === "action-required").length;
  const pending = pr.checks.filter((check) => check.status === "pending").length;
  const passed = pr.checks.filter((check) => check.status === "success").length;
  const count = pr.checks.length ? `${passed} of ${pr.checks.length}` : undefined;
  if (failed)
    return {
      label: `${failed} ${failed === 1 ? "check" : "checks"} failing`,
      title: `${failed} ${failed === 1 ? "check" : "checks"} failing`,
      count,
      icon: "exclamationmark.circle",
      tint: "accent-danger-foreground",
    } as const;
  if (required)
    return {
      label: `${required} need attention`,
      title: "Checks need attention",
      count: `${required} awaiting action`,
      icon: "exclamationmark.circle",
      tint: "accent-warning-foreground",
    } as const;
  if (pending)
    return {
      label: `${pending} pending`,
      title: "Checks running",
      count: `${pending} pending`,
      icon: "clock",
      tint: "accent-warning-foreground",
    } as const;
  if (passed)
    return {
      label: `${passed} of ${pr.checks.length} passed`,
      title: passed === pr.checks.length ? "All checks passed" : "Checks completed",
      count,
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
    } as const;
  return {
    label: pr.checks.length ? `${pr.checks.length} completed` : "No checks reported",
    title: pr.checks.length ? "Checks completed" : "No checks reported",
    count,
    icon: "minus",
    tint: "accent-icon-muted",
  } as const;
}

export function pullRequestReviewSummary(
  pr: Pick<PullRequestDetail, "reviewers">,
  activity: Pick<PullRequestActivity, "comments" | "commits"> | null,
) {
  const latest = new Map<string, PullRequestActivity["comments"][number]>();
  const comments = new Map<string, PullRequestActivity["comments"][number]>();
  for (const review of activity?.comments ?? []) {
    if (review.kind !== "review" || !review.reviewState) continue;
    const state = review.reviewState.toUpperCase().replaceAll("-", "_");
    const key = review.author?.login ?? review.id;
    if (state === "COMMENTED") {
      const previous = comments.get(key);
      if (!previous || Date.parse(review.createdAt) >= Date.parse(previous.createdAt))
        comments.set(key, { ...review, reviewState: state });
      continue;
    }
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const previous = latest.get(key);
    if (!previous || Date.parse(review.createdAt) >= Date.parse(previous.createdAt))
      latest.set(key, { ...review, reviewState: state });
  }
  const reviews = [
    ...[...latest.values()].filter((review) => review.reviewState !== "DISMISSED"),
    ...[...comments.entries()].filter(([key]) => !latest.has(key)).map(([, review]) => review),
  ];
  const requested = reviews.filter((review) => review.reviewState === "CHANGES_REQUESTED");
  const newestCommit = Math.max(
    0,
    ...(activity?.commits.map((commit) => Date.parse(commit.committedDate)) ?? []),
  );
  const approved = reviews.filter(
    (review) => review.reviewState === "APPROVED" && Date.parse(review.createdAt) >= newestCommit,
  );
  if (requested.length)
    return {
      title: "Changes requested",
      count: `${requested.length} ${requested.length === 1 ? "reviewer" : "reviewers"}`,
      icon: "xmark.circle.fill",
      tint: "accent-danger-foreground",
      reviews,
    } as const;
  if (approved.length)
    return {
      title:
        approved.length === 1 && approved[0]?.author
          ? `Approved by ${approved[0].author.login}`
          : "Reviews approved",
      count: `${approved.length} approved`,
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
      reviews,
    } as const;
  const commented = reviews.filter((review) => review.reviewState === "COMMENTED");
  if (commented.length && !pr.reviewers.length)
    return {
      title: "Reviews",
      count: `${commented.length} commented`,
      icon: "bubble.left",
      tint: "accent-icon-muted",
      reviews,
    } as const;
  return {
    title: pr.reviewers.length ? "Awaiting review" : "Request a review",
    count: pr.reviewers.length ? `${pr.reviewers.length} requested` : "None assigned",
    icon: "person.2",
    tint: "accent-icon-muted",
    reviews,
  } as const;
}

export function pullRequestBranchSummary(
  pr: Pick<PullRequestDetail, "mergeability" | "baseComparison" | "behindBy" | "baseBranch">,
) {
  if (pr.mergeability === "conflicting") return "Has conflicts";
  if (pr.baseComparison === "behind") return `${pr.behindBy ?? ""} behind ${pr.baseBranch}`.trim();
  if (pr.baseComparison === "up-to-date") return "Up to date";
  return pr.mergeability === "mergeable" ? "No conflicts" : "Not reported";
}
