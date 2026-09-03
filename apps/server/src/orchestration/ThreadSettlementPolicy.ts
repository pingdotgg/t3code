import type { OrchestrationThreadShell } from "@t3tools/contracts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value == null) continue;
    const valueMs = Date.parse(value);
    if (valueMs > latestMs) {
      latest = value;
      latestMs = valueMs;
    }
  }
  return latest;
}

/** A recent user message stays queued until a turn adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. */
export function threadHasQueuedTurnStart(
  thread: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const age = Date.parse(now) - messageAt;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((value) => value == null || Date.parse(value) < messageAt);
}

function pullRequestSettles(
  thread: Pick<OrchestrationThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  if (pullRequest.updatedAt === null) return false;
  const userAnchor = latestTimestamp([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
  ]);
  if (userAnchor === null) return false;
  const pullRequestAt = Date.parse(pullRequest.updatedAt);
  const userAnchorAt = Date.parse(userAnchor);
  if (Number.isNaN(pullRequestAt) || Number.isNaN(userAnchorAt)) return false;
  return pullRequestAt >= userAnchorAt;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationThreadShell;
  readonly pullRequest: SettlementPullRequest | null;
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): string | null {
  const { thread, pullRequest } = input;
  if (!isAutoSettlementCandidate(thread, input.now)) return null;
  const activityAt = latestTimestamp([
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]);
  if (pullRequest !== null) {
    if (pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
      return activityAt ?? thread.createdAt;
    }
    if (pullRequest.state === "open") return null;
  }
  if (input.autoSettleAfterDays === null || activityAt === null) return null;
  return Date.parse(activityAt) < Date.parse(input.now) - input.autoSettleAfterDays * DAY_MS
    ? activityAt
    : null;
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.backgroundLiveness != null) return false;
  if (threadHasQueuedTurnStart(thread, now)) return false;
  if (thread.snoozedUntil == null || Date.parse(thread.snoozedUntil) <= Date.parse(now))
    return true;
  const wokeOnError =
    thread.session?.status === "error" &&
    (thread.snoozedAt == null ||
      Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt));
  const wokeOnCompletion =
    thread.snoozedAt != null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt != null &&
    Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt);
  return wokeOnError || wokeOnCompletion;
}
