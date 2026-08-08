import type {
  ChangeRequestState,
  OrchestrationThreadShell,
  ThreadAutoSettleAfterDays,
} from "@t3tools/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Session adoption takes seconds. A newer user message with no adopted turn
// is pending work, but old unmatched messages must not block settlement forever.
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export type AutomaticSettlementReason = "inactivity" | "pr-merged";
export type AutomaticSettlementChangeRequestState =
  | ChangeRequestState
  | "open-cached"
  | "closed-cached"
  | "unknown"
  | null;
export type AutomaticSettlementVerdict =
  | { readonly kind: "skip" }
  | { readonly kind: "verify-pr" }
  | { readonly kind: "settle"; readonly reason: AutomaticSettlementReason };

export function threadLastActivityAt(shell: OrchestrationThreadShell): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate == null) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

export function shellHasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (shell.latestUserMessageAt == null || shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(messageAt) || !Number.isFinite(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (shell.latestTurn === null) return true;
  return [
    shell.latestTurn.requestedAt,
    shell.latestTurn.startedAt,
    shell.latestTurn.completedAt,
  ].every((candidate) => candidate == null || Date.parse(candidate) < messageAt);
}

/**
 * Resolves the server-owned automatic settlement transition. Explicit user
 * state wins, live or blocked work stays active, and a visible pin suppresses
 * inactivity only. A merged PR is the one automatic signal allowed to settle
 * and unpin a pinned thread.
 */
export function resolveAutomaticSettlementVerdict(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: ThreadAutoSettleAfterDays | null;
    readonly changeRequestState: AutomaticSettlementChangeRequestState;
  },
): AutomaticSettlementVerdict {
  if (shell.settledOverride !== null) return { kind: "skip" };
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return { kind: "skip" };
  if (shell.session?.status === "starting" || shell.session?.status === "running") {
    return { kind: "skip" };
  }
  if (shellHasQueuedTurnStart(shell, options.now)) return { kind: "skip" };

  if (options.changeRequestState === "merged") {
    return { kind: "settle", reason: "pr-merged" };
  }
  // Cached non-terminal states can hide a later merge. Re-verify them on the
  // reactor's bounded cooldown even for fresh or pinned threads.
  if (
    options.changeRequestState === "unknown" ||
    options.changeRequestState === "open-cached" ||
    options.changeRequestState === "closed-cached"
  ) {
    return { kind: "verify-pr" };
  }
  if (shell.pinnedAt != null) return { kind: "skip" };
  if (options.changeRequestState === "open") return { kind: "skip" };
  if (options.autoSettleAfterDays === null) return { kind: "skip" };

  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return { kind: "skip" };
  return Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
    ? { kind: "settle", reason: "inactivity" }
    : { kind: "skip" };
}

export function resolveAutomaticSettlementReason(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: ThreadAutoSettleAfterDays | null;
    readonly changeRequestState: ChangeRequestState | null;
  },
): AutomaticSettlementReason | null {
  const verdict = resolveAutomaticSettlementVerdict(shell, options);
  return verdict.kind === "settle" ? verdict.reason : null;
}
