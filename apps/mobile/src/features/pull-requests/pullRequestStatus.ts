import type {
  PullRequestActivity,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestMergeability,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { m, type MessageResolver } from "../../i18n/messages";
import { PullRequestGlyph } from "./pullRequestGlyphs";

const STATES = {
  open: {
    label: msg("Open", { $context: "pull request state" }),
    icon: PullRequestGlyph.pullRequest,
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
    background: "bg-adaptive-emerald-500-a12-a16",
  },
  merged: {
    label: msg("Merged", { $context: "pull request state" }),
    icon: PullRequestGlyph.merged,
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
    background: "bg-adaptive-violet-500-a12-a16",
  },
  closed: {
    label: msg("Closed", { $context: "pull request state" }),
    icon: PullRequestGlyph.closed,
    tint: "accent-danger-foreground",
    text: "text-danger-foreground",
    background: "bg-danger",
  },
  draft: {
    label: msg("Draft", { $context: "pull request state" }),
    icon: PullRequestGlyph.draft,
    tint: "accent-icon-muted",
    text: "text-foreground-muted",
    background: "bg-grouped-card",
  },
} satisfies Record<
  string,
  { label: string; icon: AppSymbolName; tint: string; text: string; background: string }
>;

export function pullRequestStatus(
  pr: Pick<PullRequestListEntry, "state" | "isDraft">,
  resolve: MessageResolver = m,
) {
  const status = STATES[pr.isDraft && pr.state === "open" ? "draft" : pr.state];
  return { ...status, label: resolve(status.label) };
}

export function pullRequestConflict(
  pr: {
    readonly state: PullRequestListEntry["state"];
    readonly isDraft: boolean;
    readonly mergeability?: PullRequestMergeability | undefined;
    readonly baseBranch?: string | undefined;
  },
  resolve: MessageResolver = m,
) {
  if (pr.state !== "open" || pr.isDraft || pr.mergeability !== "conflicting") return null;
  return {
    label: pr.baseBranch
      ? resolve(msg("Conflicts with {branch}", { branch: pr.baseBranch }))
      : resolve(msg("Has conflicts")),
  };
}

export function checkStatus(check: PullRequestCheck, resolve: MessageResolver = m) {
  switch (check.status) {
    case "success":
      return {
        label: resolve(msg("Passed", { $context: "CI check status" })),
        icon: "checkmark.circle",
        tint: "accent-adaptive-emerald-600-400",
      } as const;
    case "failure":
      return {
        label: resolve(msg("Failed", { $context: "CI check status" })),
        icon: "exclamationmark.circle",
        tint: "accent-danger-foreground",
      } as const;
    case "action-required":
      return {
        label: resolve(msg("Action required", { $context: "CI check status" })),
        icon: "exclamationmark.circle",
        tint: "accent-warning-foreground",
      } as const;
    case "pending":
      return {
        label: resolve(msg("Pending", { $context: "CI check status" })),
        icon: "clock",
        tint: "accent-warning-foreground",
      } as const;
    case "cancelled":
      return {
        label: resolve(msg("Cancelled", { $context: "CI check status" })),
        icon: "minus",
        tint: "accent-icon-muted",
      } as const;
    case "skipped":
      return {
        label: resolve(msg("Skipped", { $context: "CI check status" })),
        icon: "slash.circle",
        tint: "accent-icon-muted",
      } as const;
    case "neutral":
      return {
        label: resolve(msg("Neutral", { $context: "CI check status" })),
        icon: "minus",
        tint: "accent-icon-muted",
      } as const;
  }
}

export function isFailingCheck(check: PullRequestCheck) {
  return check.status === "failure" || check.status === "cancelled";
}

export function pullRequestChecksSummary(
  pr: Pick<PullRequestDetail, "checks">,
  resolve: MessageResolver = m,
) {
  const failed = pr.checks.filter(isFailingCheck).length;
  const required = pr.checks.filter((check) => check.status === "action-required").length;
  const pending = pr.checks.filter((check) => check.status === "pending").length;
  const passed = pr.checks.filter((check) => check.status === "success").length;
  const total = pr.checks.length;
  const count = total ? resolve(msg("{passed} of {total}", { passed, total })) : undefined;
  if (failed) {
    const failing = resolve(
      msg("{count, plural, one {{count} check failing} other {{count} checks failing}}", {
        count: failed,
      }),
    );
    return {
      label: failing,
      title: failing,
      count,
      icon: "exclamationmark.circle",
      tint: "accent-danger-foreground",
    } as const;
  }
  if (required)
    return {
      label: resolve(
        msg("{count, plural, one {{count} needs attention} other {{count} need attention}}", {
          count: required,
        }),
      ),
      title: resolve(msg("Checks need attention")),
      count: resolve(
        msg("{count, plural, one {{count} awaiting action} other {{count} awaiting action}}", {
          count: required,
        }),
      ),
      icon: "exclamationmark.circle",
      tint: "accent-warning-foreground",
    } as const;
  if (pending)
    return {
      label: resolve(
        msg("{count, plural, one {{count} pending} other {{count} pending}}", { count: pending }),
      ),
      title: resolve(msg("Checks running")),
      count: resolve(
        msg("{count, plural, one {{count} pending} other {{count} pending}}", { count: pending }),
      ),
      icon: "clock",
      tint: "accent-warning-foreground",
    } as const;
  if (passed)
    return {
      label: resolve(msg("{passed} of {total} passed", { passed, total })),
      title:
        passed === total ? resolve(msg("All checks passed")) : resolve(msg("Checks completed")),
      count,
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
    } as const;
  return {
    label: total
      ? resolve(
          msg("{count, plural, one {{count} completed} other {{count} completed}}", {
            count: total,
          }),
        )
      : resolve(msg("No checks reported")),
    title: total ? resolve(msg("Checks completed")) : resolve(msg("No checks reported")),
    count,
    icon: "minus",
    tint: "accent-icon-muted",
  } as const;
}

// GitHub and Forgejo send uppercase review states; Bitbucket and GitCafe send lowercase.
export function normalizedReviewState(reviewState: string | null) {
  return reviewState?.toUpperCase().replaceAll("-", "_");
}

export function pullRequestReviewSummary(
  pr: Pick<PullRequestDetail, "reviewers" | "reviewDecision">,
  activity: Pick<PullRequestActivity, "comments" | "commits"> | null,
  resolve: MessageResolver = m,
) {
  const latest = new Map<string, PullRequestActivity["comments"][number]>();
  const comments = new Map<string, PullRequestActivity["comments"][number]>();
  for (const review of activity?.comments ?? []) {
    const state = normalizedReviewState(review.reviewState);
    if (review.kind !== "review" || !state) continue;
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
  const newestCommit = Math.max(
    0,
    ...(activity?.commits.map((commit) => Date.parse(commit.committedDate)) ?? []),
  );
  const reviews = [
    ...[...latest.values()].filter((review) => review.reviewState !== "DISMISSED"),
    ...[...comments.entries()].filter(([key]) => !latest.has(key)).map(([, review]) => review),
  ].map((review) => ({
    ...review,
    outdated: review.reviewState === "APPROVED" && Date.parse(review.createdAt) < newestCommit,
  }));
  const requested = reviews.filter((review) => review.reviewState === "CHANGES_REQUESTED");
  const approved = reviews.filter(
    (review) => review.reviewState === "APPROVED" && !review.outdated,
  );
  // The host's own decision, where it gives one, outranks what the reviews alone suggest.
  const decision =
    pr.reviewDecision ??
    (requested.length ? "changes-requested" : approved.length ? "approved" : null);
  if (decision === "changes-requested")
    return {
      title: resolve(msg("Changes requested")),
      count: resolve(
        msg("{count, plural, one {{count} reviewer} other {{count} reviewers}}", {
          // A host's decision implies at least one verdict before the activity names it.
          count: Math.max(requested.length, 1),
        }),
      ),
      icon: "xmark.circle.fill",
      tint: "accent-danger-foreground",
      reviews,
    } as const;
  if (decision === "approved")
    return {
      title:
        approved.length === 1 && approved[0]?.author
          ? resolve(msg("Approved by {login}", { login: approved[0].author.login }))
          : resolve(msg("Reviews approved")),
      count: resolve(
        msg("{count, plural, one {{count} approved} other {{count} approved}}", {
          count: Math.max(approved.length, 1),
        }),
      ),
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
      reviews,
    } as const;
  const commented = reviews.filter((review) => review.reviewState === "COMMENTED");
  if (decision !== "review-required" && commented.length && !pr.reviewers.length)
    return {
      title: resolve(msg("Reviews")),
      count: resolve(
        msg("{count, plural, one {{count} commented} other {{count} commented}}", {
          count: commented.length,
        }),
      ),
      icon: "bubble.left",
      tint: "accent-icon-muted",
      reviews,
    } as const;
  return {
    title: pr.reviewers.length ? resolve(msg("Awaiting review")) : resolve(msg("Request a review")),
    count: pr.reviewers.length
      ? resolve(
          msg("{count, plural, one {{count} requested} other {{count} requested}}", {
            count: pr.reviewers.length,
          }),
        )
      : resolve(msg("None assigned")),
    icon: "person.2",
    tint: "accent-icon-muted",
    reviews,
  } as const;
}

export function pullRequestBranchSummary(
  pr: Pick<PullRequestDetail, "mergeability" | "baseComparison" | "behindBy" | "baseBranch">,
  resolve: MessageResolver = m,
) {
  if (pr.mergeability === "conflicting") return resolve(msg("Has conflicts"));
  if (pr.baseComparison === "behind")
    return pr.behindBy == null
      ? resolve(msg("behind {branch}", { branch: pr.baseBranch }))
      : resolve(
          msg("{count, plural, one {{count} behind {branch}} other {{count} behind {branch}}}", {
            count: pr.behindBy,
            branch: pr.baseBranch,
          }),
        );
  if (pr.baseComparison === "up-to-date") return resolve(msg("Up to date"));
  return pr.mergeability === "mergeable"
    ? resolve(msg("No conflicts"))
    : resolve(msg("Not reported"));
}

export function pullRequestChecksStatus(state: PullRequestChecksState) {
  if (state === "passing")
    return { icon: "checkmark.circle", tint: "accent-adaptive-emerald-600-400" } as const;
  if (state === "failing")
    return { icon: "xmark.circle.fill", tint: "accent-danger-foreground" } as const;
  return { icon: "clock", tint: "accent-warning-foreground" } as const;
}
