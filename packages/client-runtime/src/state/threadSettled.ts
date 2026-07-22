import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ChangeRequestStateLike = "open" | "closed" | "merged";

const DAY_MS = 24 * 60 * 60 * 1_000;

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
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * A user message no turn has picked up yet: the turn.start command was
 * dispatched (message-sent + turn-start-requested) but no session has
 * adopted it, so `session` is still null and the pending work is invisible
 * to the session-status checks. Detectable as a user message strictly newer
 * than every timestamp on the latest turn — on adoption the new turn's
 * requestedAt equals the message time, clearing the condition — and only
 * within the adoption grace window.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  // A failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * A thread may be settled only when none of effectiveSettled's activity
 * blockers hold. This is deliberately the same list: anything the partition
 * refuses to CLASSIFY as settled must also be refused as a settle TARGET.
 * The server enforces its own invariants; this client-side twin exists so
 * the UI can disable/reject before a round trip.
 */
export function canSettle(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  // Queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * Settled resolution over the server-backed settled lifecycle. The explicit
 * user override (thread.settle / thread.unsettle commands, projected into
 * settledOverride + settledAt) wins in both directions; without one, a
 * thread auto-settles on a merged/closed PR or inactivity past the window.
 * The server un-settles on real activity (user message, session start,
 * approval/user-input request), so an override never goes stale silently.
 */
export function effectiveSettled(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly changeRequestState?: ChangeRequestStateLike | null;
  },
): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  if (hasQueuedTurnStart(shell, { now: options.now })) {
    // The queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt !== null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  if (shell.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === "active") return false;
  if (options.changeRequestState === "merged" || options.changeRequestState === "closed") {
    return true;
  }
  if (options.autoSettleAfterDays === null) return false;

  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return false;

  // threadLastActivityAt only returns candidates whose Date.parse beat
  // -Infinity, so this parse is a real number; a malformed `now` yields NaN,
  // the comparison is false, and the thread stays active (never a surprise
  // auto-settle on bad input).
  return (
    Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
  );
}
