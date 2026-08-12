export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

type ThreadLifecycleSnapshot = {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** Shell-projected non-failed queue (handoff continuation or user follow-up). */
  readonly hasPendingQueuedTurn?: boolean;
  readonly latestUserMessageAt: string | null;
  readonly latestTurn: {
    readonly state: string;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: {
    readonly status: string;
    readonly updatedAt: string;
  } | null;
};

function isWithinQueuedTurnStartGrace(messageAt: string, now: string): boolean {
  const messageAtMs = Date.parse(messageAt);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(messageAtMs) &&
    Number.isFinite(nowMs) &&
    Math.abs(nowMs - messageAtMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

/**
 * Detects a newly submitted message that has not yet been adopted by a
 * provider turn. The grace window prevents stale shells or clock skew from
 * keeping a thread permanently classified as in flight.
 */
export function hasQueuedTurnStart(
  shell: Pick<ThreadLifecycleSnapshot, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt === null || shell.session?.status === "error") {
    return false;
  }
  if (!isWithinQueuedTurnStartGrace(shell.latestUserMessageAt, options.now)) {
    return false;
  }

  const latestTurn = shell.latestTurn;
  if (latestTurn === null) {
    return true;
  }

  const latestMessageAtMs = Date.parse(shell.latestUserMessageAt);
  return [latestTurn.requestedAt, latestTurn.startedAt, latestTurn.completedAt].every(
    (timestamp) => timestamp === null || Date.parse(timestamp) < latestMessageAtMs,
  );
}

export function canSettle(
  shell: ThreadLifecycleSnapshot,
  options: { readonly now: string },
): boolean {
  return (
    !shell.hasPendingApprovals &&
    !shell.hasPendingUserInput &&
    !shell.hasPendingQueuedTurn &&
    shell.session?.status !== "starting" &&
    shell.session?.status !== "error" &&
    shell.latestTurn?.state !== "running" &&
    !hasQueuedTurnStart(shell, options)
  );
}

export type ThreadSnoozeShell = Pick<
  ThreadLifecycleSnapshot,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn"
> & {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
};

export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  const snoozedAt = shell.snoozedAt ?? null;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
    return true;
  }
  if (
    shell.session?.status === "error" &&
    (snoozedAt === null || Date.parse(shell.session.updatedAt) > Date.parse(snoozedAt))
  ) {
    return true;
  }
  return (
    snoozedAt !== null &&
    shell.latestTurn?.state === "completed" &&
    shell.latestTurn.completedAt !== null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(snoozedAt)
  );
}

export function canSnooze(
  shell: ThreadLifecycleSnapshot,
  options: { readonly now: string },
): boolean {
  return (
    !shell.hasPendingApprovals &&
    !shell.hasPendingUserInput &&
    !shell.hasPendingQueuedTurn &&
    !hasQueuedTurnStart(shell, options)
  );
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil === null || shell.snoozedUntil === undefined) {
    return false;
  }
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  return (
    Number.isFinite(wakeAtMs) &&
    wakeAtMs > Date.parse(options.now) &&
    !threadRaisedHandWhileSnoozed(shell)
  );
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil === null || shell.snoozedUntil === undefined) {
    return null;
  }
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (!Number.isFinite(wakeAtMs)) {
    return null;
  }
  if (threadRaisedHandWhileSnoozed(shell)) {
    const snoozedAt = shell.snoozedAt ?? null;
    if (
      snoozedAt !== null &&
      shell.latestTurn?.state === "completed" &&
      shell.latestTurn.completedAt !== null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(snoozedAt)
    ) {
      return shell.latestTurn.completedAt;
    }
    return shell.session?.updatedAt ?? snoozedAt;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

/**
 * V1 intentionally has no automatic inactivity or pull-request settlement.
 * The durable explicit lifecycle still honors blockers so a stale settlement
 * can never hide a thread that now needs attention.
 */
export function effectiveSettled(
  shell: ThreadLifecycleSnapshot & {
    readonly settledOverride?: "settled" | "active" | null;
  },
  options: { readonly now: string },
): boolean {
  if (!canSettle(shell, options)) {
    return false;
  }
  return shell.settledOverride === "settled";
}
