import type {
  OrchestrationTaskShell,
  OrchestrationThreadShell,
  ServerSettings,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

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
  now: string | number,
): boolean {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const age = (typeof now === "number" ? now : Date.parse(now)) - messageAt;
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
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchor = latestTimestamp([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
  ]);
  if (userAnchor === null) return false;
  const pullRequestAt = Date.parse(terminalAt);
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
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = visibleThreadPullRequests(thread.pullRequests);
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return null;
  if (links.length > 0) {
    const terminalTimestamp = (link: (typeof links)[number]) => {
      const snapshot = link.snapshot;
      const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
      const timestamp = Date.parse(value ?? "");
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const latest = links.reduce((current, candidate) =>
      terminalTimestamp(candidate) > terminalTimestamp(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
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

/** Task settlement parks the container only; snoozed members may still be running. */
export function resolveTaskAutoSettlementAt(input: {
  readonly task: OrchestrationTaskShell;
  readonly members: ReadonlyArray<
    Pick<
      OrchestrationThreadShell,
      | "archivedAt"
      | "backgroundLiveness"
      | "settledOverride"
      | "settledAt"
      | "snoozedUntil"
      | "snoozedAt"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "latestUserMessageAt"
      | "latestTurn"
      | "session"
    >
  >;
  readonly settings: Pick<ServerSettings, "sidebarAutoSettleAfterDays">;
  readonly nowMs: number;
}): string | null {
  const { task, settings, nowMs } = input;
  if (task.archivedAt !== null || task.settledOverride !== null) return null;
  if (task.snoozedUntil !== null && Date.parse(task.snoozedUntil) > nowMs) return null;
  if (settings.sidebarAutoSettleAfterDays === null) return null;
  const members = input.members.filter((member) => member.archivedAt === null);
  for (const member of members) {
    if (member.hasPendingApprovals || member.hasPendingUserInput) return null;
    if (threadHasQueuedTurnStart(member, nowMs)) return null;
    const liveSession =
      member.session?.status === "running" || member.session?.status === "starting";
    if (member.settledOverride === "settled" && !liveSession && member.backgroundLiveness == null)
      continue;
    const snoozed = member.snoozedUntil != null && Date.parse(member.snoozedUntil) > nowMs;
    const freshError =
      member.session?.status === "error" &&
      (member.snoozedAt == null ||
        Date.parse(member.session.updatedAt) > Date.parse(member.snoozedAt));
    const freshCompletion =
      member.snoozedAt != null &&
      member.latestTurn?.state === "completed" &&
      member.latestTurn.completedAt != null &&
      Date.parse(member.latestTurn.completedAt) > Date.parse(member.snoozedAt);
    if (!snoozed || freshError || freshCompletion) return null;
  }
  const anchor = taskSettlementActivityAnchor({ task, members });
  return anchor !== null &&
    Date.parse(anchor) < nowMs - settings.sidebarAutoSettleAfterDays * DAY_MS
    ? anchor
    : null;
}

/** The decision and its stale-snapshot guard compare this same activity anchor. */
function taskSettlementActivityAnchor(input: {
  readonly task: Pick<OrchestrationTaskShell, "createdAt" | "updatedAt">;
  readonly members: ReadonlyArray<
    Pick<OrchestrationThreadShell, "settledAt" | "snoozedAt" | "latestUserMessageAt" | "latestTurn">
  >;
}): string | null {
  return latestTimestamp([
    input.task.createdAt,
    input.task.updatedAt,
    ...input.members.flatMap((member) => [
      member.settledAt,
      member.snoozedAt,
      member.latestUserMessageAt,
      member.latestTurn?.requestedAt,
      member.latestTurn?.startedAt,
      member.latestTurn?.completedAt,
    ]),
  ]);
}
