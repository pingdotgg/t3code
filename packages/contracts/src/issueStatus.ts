import type { IssueReviewMark, IssueState } from "./issues.ts";

/**
 * The computed Issue status (toolboxmd/t3code#29), in the order of the status table in
 * toolboxmd/t3code#25: the first rule that matches wins, and groups show in this order.
 */
export const ISSUE_STATUSES = [
  "done",
  "not-planned",
  "in-review",
  "in-progress",
  "waiting-for-merge",
  "changes-requested",
  "waiting-for-review",
  "paused",
  "blocked",
  "discussion",
  "to-do",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface IssueStatusPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  /** Already filtered to the trusted accounts. */
  readonly reviewMark: IssueReviewMark | null;
}

export interface IssueStatusInput {
  readonly state: IssueState;
  readonly openBlockerCount: number;
  /**
   * Pull requests that close the Issue plus those linked to its linked threads, once each. Only
   * open ones count: a merged one with the Issue still open is a component PR whose final PR
   * into the default branch closes the Issue.
   */
  readonly pullRequests: ReadonlyArray<IssueStatusPullRequest>;
  /** A linked thread's branch names the Issue (`<type>/<number>-<slug>`). */
  readonly hasTaskBranch: boolean;
  readonly linkedThreadCount: number;
  /** A linked thread, or any of its descendant child threads, is working now. */
  readonly workingNow: boolean;
}

/**
 * The status table, first match wins. An open draft counts as work in progress, not as a pull
 * request waiting for review, so with nobody working it reads as Paused.
 */
export function issueStatusOf(input: IssueStatusInput): IssueStatus {
  if (input.state === "done") return "done";
  if (input.state === "not-planned") return "not-planned";
  const open = input.pullRequests.filter((pullRequest) => pullRequest.state === "open");
  const marks = new Set(open.map((pullRequest) => pullRequest.reviewMark));
  const inProgress = input.hasTaskBranch || open.length > 0;
  if (marks.has("pending")) return "in-review";
  if (inProgress && input.workingNow) return "in-progress";
  if (marks.has("success")) return "waiting-for-merge";
  if (marks.has("failure")) return "changes-requested";
  if (open.some((pullRequest) => !pullRequest.isDraft)) return "waiting-for-review";
  if (inProgress) return "paused";
  if (input.openBlockerCount > 0) return "blocked";
  if (input.linkedThreadCount > 0) return "discussion";
  return "to-do";
}

/** A review mark counts only when one of the trusted accounts (logins, any case) posted it. */
export function trustedReviewMark(
  review: { readonly state: IssueReviewMark; readonly creator: string | null } | null,
  trustedLogins: ReadonlySet<string>,
): IssueReviewMark | null {
  const creator = review?.creator?.toLowerCase() ?? "";
  return review !== null && creator.length > 0 && trustedLogins.has(creator) ? review.state : null;
}
