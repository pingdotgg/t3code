import type {
  OrchestrationCheckpointSummary,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Predicate from "effect/Predicate";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const VERIFICATION_COMMANDS = [
  /^(?:(?:(?:corepack\s+)?(?:pnpm|npm|yarn|bun)\s+exec\s+)?vp|(?:\.\/)?node_modules\/\.bin\/vp)\s+(?:test(?:\s+run)?|lint|typecheck|check)(?:\s|$)/u,
  /^(?:corepack\s+)?(?:pnpm|npm|yarn|bun)\s+(?:(?:run\s+)?(?:test|lint|typecheck|check))(?:[\s:]|$)/u,
  /^(?:(?:corepack\s+)?(?:pnpm|npm|yarn|bun)\s+exec\s+)?(?:vitest|pytest)(?:\s|$)/u,
  /^(?:bunx|npx)\s+(?:vitest|pytest)(?:\s|$)/u,
  /^python3?\s+-m\s+(?:pytest|unittest)(?:\s|$)/u,
  /^cargo\s+test(?:\s|$)/u,
  /^go\s+test(?:\s|$)/u,
  /^dotnet\s+test(?:\s|$)/u,
  /^mvn\s+test(?:\s|$)/u,
  /^(?:gradle|\.\/gradlew)\s+(?:test|check)(?:\s|$)/u,
  /^git\s+diff\s+--check(?:\s|$)/u,
] as const;
const MUTATING_VERIFICATION_ARGUMENT =
  /(?:^|\s)(?:--(?:fix|write|update(?:Snapshot|-snapshots)?|bless)(?:=\S+)?|-u)(?:\s|$)/u;
const MUTATING_VERIFICATION_SCRIPT =
  /(?:^|\s)(?:test|lint|typecheck|check):(?:fix|write|update|snapshot|bless)(?:[-_:][^\s]+)*(?:\s|$)/u;

function normalizeCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const shellWrapped = trimmed.match(
    /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|)sh\s+-lc\s+(['"])([\s\S]*)\1$/u,
  );
  const command = (shellWrapped?.[2] ?? trimmed).trim();
  if (/[;&|`]|\$\(/u.test(command)) return null;
  return command;
}

function commandFromActivity(activity: OrchestrationThreadActivity): string | null {
  if (!Predicate.isObject(activity.payload)) return null;
  const data = Predicate.isObject(activity.payload.data) ? activity.payload.data : undefined;
  const item = data && Predicate.isObject(data.item) ? data.item : undefined;
  const itemInput = item && Predicate.isObject(item.input) ? item.input : undefined;
  const itemResult = item && Predicate.isObject(item.result) ? item.result : undefined;
  const candidates = [
    data?.command,
    item?.command,
    itemInput?.command,
    itemResult?.command,
    activity.payload.detail,
  ];
  return candidates.map(normalizeCommand).find((command) => command !== null) ?? null;
}

function isVerificationCommand(command: string | null): boolean {
  return (
    command !== null &&
    !MUTATING_VERIFICATION_ARGUMENT.test(command) &&
    !MUTATING_VERIFICATION_SCRIPT.test(command) &&
    VERIFICATION_COMMANDS.some((pattern) => pattern.test(command))
  );
}

function successfulToolActivity(
  activity: OrchestrationThreadActivity,
  itemType: "command_execution" | "file_change",
): boolean {
  if (activity.kind !== "tool.completed" || !Predicate.isObject(activity.payload)) return false;
  return activity.payload.itemType === itemType && activity.payload.status === "completed";
}

function compareActivityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function latestActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | null {
  return activities.reduce<OrchestrationThreadActivity | null>(
    (latest, activity) =>
      latest === null || compareActivityOrder(activity, latest) > 0 ? activity : latest,
    null,
  );
}

/** Automatic settlement only accepts inspectable verification after the last mutation. */
export function verificationAllowsAutoSettlement(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}): boolean {
  const mutations = input.activities.filter((activity) =>
    successfulToolActivity(activity, "file_change"),
  );
  const hasChangedCheckpoint = input.checkpoints.some(
    (checkpoint) => checkpoint.status === "ready" && checkpoint.files.length > 0,
  );
  if (mutations.length === 0) return !hasChangedCheckpoint;

  const latestMutation = latestActivity(mutations);
  const latestVerification = latestActivity(
    input.activities.filter(
      (activity) =>
        successfulToolActivity(activity, "command_execution") &&
        isVerificationCommand(commandFromActivity(activity)),
    ),
  );
  return (
    latestMutation !== null &&
    latestVerification !== null &&
    compareActivityOrder(latestVerification, latestMutation) > 0
  );
}

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
