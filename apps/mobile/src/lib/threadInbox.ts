import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Mobile port of the mac inbox semantics
 * (apps/mac/Sources/SergeCodeMac/UI/Shell/ThreadInboxSemantics.swift, mirrored
 * in packages/client-runtime/src/state/threadSettled.ts, which the app cannot
 * import because client-runtime does not export that module). The server is
 * authoritative for explicit settle/unsettle transitions; these helpers mirror
 * the client-side rules for automatic settlement, settle eligibility, and
 * stable settled ordering.
 */

/** Threads with no activity for this long auto-settle (mac default). */
export const THREAD_AUTO_SETTLE_AFTER_DAYS = 3;

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start, not pending work.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

type InboxThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestTurn"
  | "session"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "settledOverride"
  | "settledAt"
>;

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

export function threadLastActivityAt(thread: InboxThread): string | null {
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
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
 * A user message no turn has picked up yet, within the adoption grace window:
 * the turn.start was dispatched but no session has adopted it, so the pending
 * work is invisible to the session-status checks.
 */
export function hasQueuedTurnStart(thread: InboxThread, now?: string): boolean {
  if (thread.latestUserMessageAt == null) return false;
  // A failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(nowIso(now));
  if (Number.isNaN(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * A thread may be settled only when none of isThreadSettled's activity
 * blockers hold: anything the partition refuses to CLASSIFY as settled must
 * also be refused as a settle TARGET. The server enforces its own invariants;
 * this client-side twin lets the UI disable/reject before a round trip.
 */
export function canSettleThread(thread: InboxThread, now?: string): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  return !hasQueuedTurnStart(thread, now);
}

/**
 * Settled resolution over the server-backed settled lifecycle. The explicit
 * user override (thread.settle / thread.unsettle, projected into
 * settledOverride + settledAt) wins in both directions; without one, a thread
 * auto-settles on inactivity past the window. (The mac PR-merged/closed
 * auto-settle is omitted: the mobile list builders have no PR state, matching
 * mac's `changeRequestState: nil` default.)
 */
export function isThreadSettled(thread: InboxThread, now?: string): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (hasQueuedTurnStart(thread, now)) {
    // The queued-turn blocker alone is forgivable: it is clock-derived. When
    // the server already adjudicated the queued message by accepting a settle
    // after it (settledAt stamps server accept time), trust that ruling. A
    // message NEWER than settledAt is genuinely new work and keeps the block
    // until the server's auto-unsettle lands.
    const serverAdjudicated =
      thread.settledOverride === "settled" &&
      thread.settledAt != null &&
      thread.latestUserMessageAt !== null &&
      Date.parse(thread.settledAt) >= Date.parse(thread.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  if (thread.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle until
  // real activity clears it server-side.
  if (thread.settledOverride === "active") return false;

  const lastActivityAt = threadLastActivityAt(thread);
  if (lastActivityAt === null) return false;
  const activityAt = Date.parse(lastActivityAt);
  const nowMs = Date.parse(nowIso(now));
  if (Number.isNaN(activityAt) || Number.isNaN(nowMs)) return false;
  return activityAt < nowMs - THREAD_AUTO_SETTLE_AFTER_DAYS * DAY_MS;
}

/** Sort timestamp for settled threads (mac `settledTimestamp`). */
export function settledTimestamp(thread: InboxThread): string {
  return thread.settledAt ?? threadLastActivityAt(thread) ?? thread.updatedAt;
}

/** Most recently settled first; id ascending breaks ties (mac `sortSettled`). */
export function sortSettledThreads<T extends InboxThread>(threads: ReadonlyArray<T>): T[] {
  return [...threads].sort((left, right) => {
    const leftAt = Date.parse(settledTimestamp(left));
    const rightAt = Date.parse(settledTimestamp(right));
    if (leftAt !== rightAt) return rightAt - leftAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * The swipe primary action for a thread row, by lifecycle state: settled
 * threads offer "Unsettle", settleable active threads offer "Settle", and
 * anything else (running, blocked on approvals/input) keeps "Archive".
 */
export type ThreadListPrimaryActionKind = "settle" | "unsettle" | "archive";

export function resolveThreadListPrimaryAction(
  thread: InboxThread,
  now?: string,
): ThreadListPrimaryActionKind {
  if (isThreadSettled(thread, now)) return "unsettle";
  if (canSettleThread(thread, now)) return "settle";
  return "archive";
}
