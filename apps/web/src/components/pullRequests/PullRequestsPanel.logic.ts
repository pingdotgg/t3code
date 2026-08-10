/**
 * Pure helpers for the Code Review & PRs panel.
 *
 * The panel splits the repo's change requests into "Assigned to me" and
 * "Not assigned to me". Who "me" is comes from the source control provider's
 * authenticated account (`sourceControl.discovery`), which each provider spells
 * differently: GitHub and GitLab report a login/username, Azure DevOps reports
 * an email-shaped `uniqueName`, and Bitbucket a nickname. `matchesViewer`
 * reconciles those shapes so a GitHub-style login still matches an
 * email-shaped assignee for the same person.
 */
import type { ChangeRequest, OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type PullRequestTab = "assigned" | "unassigned";

export interface PullRequestPartition {
  readonly assigned: ReadonlyArray<ChangeRequest>;
  readonly unassigned: ReadonlyArray<ChangeRequest>;
}

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/** The part of an email-shaped handle before `@`, or the handle itself. */
function localPart(handle: string): string {
  const atIndex = handle.indexOf("@");
  return atIndex > 0 ? handle.slice(0, atIndex) : handle;
}

export function matchesViewer(handle: string, viewer: string): boolean {
  const normalizedHandle = normalizeHandle(handle);
  const normalizedViewer = normalizeHandle(viewer);
  if (normalizedHandle.length === 0 || normalizedViewer.length === 0) return false;
  if (normalizedHandle === normalizedViewer) return true;
  return localPart(normalizedHandle) === localPart(normalizedViewer);
}

export function isAssignedToViewer(changeRequest: ChangeRequest, viewer: string | null): boolean {
  if (viewer === null) return false;
  return (changeRequest.assignees ?? []).some((assignee) => matchesViewer(assignee, viewer));
}

function updatedAtMillis(changeRequest: ChangeRequest): number {
  const updatedAt = Option.getOrNull(changeRequest.updatedAt);
  return updatedAt === null ? 0 : updatedAt.epochMilliseconds;
}

/** Most recently updated first; ties break on the higher (newer) number. */
export function sortChangeRequests(
  changeRequests: ReadonlyArray<ChangeRequest>,
): ReadonlyArray<ChangeRequest> {
  return [...changeRequests].sort((left, right) => {
    const byUpdatedAt = updatedAtMillis(right) - updatedAtMillis(left);
    return byUpdatedAt !== 0 ? byUpdatedAt : right.number - left.number;
  });
}

export function partitionChangeRequests(
  changeRequests: ReadonlyArray<ChangeRequest>,
  viewer: string | null,
): PullRequestPartition {
  const assigned: ChangeRequest[] = [];
  const unassigned: ChangeRequest[] = [];
  for (const changeRequest of sortChangeRequests(changeRequests)) {
    if (isAssignedToViewer(changeRequest, viewer)) {
      assigned.push(changeRequest);
    } else {
      unassigned.push(changeRequest);
    }
  }
  return { assigned, unassigned };
}

export function filterChangeRequests(
  changeRequests: ReadonlyArray<ChangeRequest>,
  query: string,
): ReadonlyArray<ChangeRequest> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return changeRequests;
  // A leading "#" is how people type PR numbers; matching it literally against
  // the number would never hit.
  const numberNeedle = needle.startsWith("#") ? needle.slice(1) : needle;
  return changeRequests.filter((changeRequest) =>
    [
      changeRequest.title,
      String(changeRequest.number),
      changeRequest.headRefName,
      changeRequest.baseRefName,
      changeRequest.author ?? "",
      ...(changeRequest.assignees ?? []),
    ].some((field) => field.toLowerCase().includes(numberNeedle)),
  );
}

/**
 * The provider account the panel treats as "me".
 *
 * Only the provider backing this repo counts: a user authenticated with both
 * `gh` and `glab` must not have their GitHub login match assignees on a GitLab
 * repo.
 */
export type CodeReviewStatus = "reviewing" | "reviewed" | "failed" | "stopped";

/**
 * Chip state for a PR that has a review thread.
 *
 * A thread that exists but has no turn yet is still "reviewing": the create and
 * turn-start commands are two round trips, and the gap between them must not
 * read as a finished review.
 */
export function deriveCodeReviewStatus(
  thread: OrchestrationThread | null,
): CodeReviewStatus | null {
  if (thread === null) return null;
  const latestTurn = thread.latestTurn;
  if (latestTurn === null) return "reviewing";
  switch (latestTurn.state) {
    case "running":
      return "reviewing";
    case "completed":
      return "reviewed";
    case "error":
      return "failed";
    case "interrupted":
      return "stopped";
  }
}

/**
 * Row-level chip state.
 *
 * A recorded review whose thread snapshot has not streamed in yet still reads
 * as "reviewing": the review demonstrably started, and blanking the chip until
 * the snapshot arrives makes a running review look like it was never launched.
 */
export function resolveRowReviewStatus(input: {
  readonly reviewThreadId: string | null;
  readonly thread: OrchestrationThread | null;
}): CodeReviewStatus | null {
  if (input.reviewThreadId === null) return null;
  return deriveCodeReviewStatus(input.thread) ?? "reviewing";
}

export const CODE_REVIEW_STATUS_LABELS: Record<CodeReviewStatus, string> = {
  reviewing: "Reviewing…",
  reviewed: "Reviewed",
  failed: "Review failed",
  stopped: "Review stopped",
};

export function selectViewerAccount(
  providers: ReadonlyArray<{
    readonly kind: string;
    readonly auth: { readonly account: Option.Option<string> };
  }>,
  providerKind: string | null,
): string | null {
  if (providerKind === null || providerKind === "unknown") return null;
  const provider = providers.find((entry) => entry.kind === providerKind);
  return provider ? Option.getOrNull(provider.auth.account) : null;
}
