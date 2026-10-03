import type { OrchestrationPendingTurnStart } from "@t3tools/contracts";

/**
 * Authoritative busy-state derivation for an orchestration thread.
 *
 * Acceptance and provider acknowledgement are two separate commits. A
 * `thread.turn.start` is authoritative from the moment it commits, but
 * `latestTurn` and the session only report work once the provider
 * acknowledges. `pendingTurnStart` covers exactly that window, so it is the only
 * signal that decides whether another turn may start.
 *
 * Message and turn timestamps cannot stand in for this. A manual stop can share
 * a message's millisecond with its terminal turn, and a forked thread or a turn
 * that produced no checkpoint leaves no completed turn to compare against — that
 * second case is what previously wedged a thread so every later turn start was
 * rejected while the UI showed it idle.
 *
 * Lives here rather than in `packages/contracts`, which is schema-only.
 * `packages/shared` already depends on contracts, and both the server invariant
 * and the web client import from here, so neither can drift from the other.
 */

export type ThreadBusyState = "idle" | "pending" | "running";

/** Minimal shape needed to derive busy state; both clients and the read model satisfy it. */
export interface ThreadBusyInput {
  readonly latestTurn?: { readonly state: string } | null;
  readonly pendingTurnStart?: OrchestrationPendingTurnStart | null;
  readonly session?: {
    readonly status: string;
    readonly activeTurnId?: string | null;
  } | null;
}

export function deriveThreadBusyState(thread: ThreadBusyInput): ThreadBusyState {
  if (thread.latestTurn?.state === "running") {
    return "running";
  }
  if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
    return "running";
  }
  if (thread.pendingTurnStart != null) {
    return "pending";
  }
  return "idle";
}

/**
 * Whether an accepted-but-unacknowledged turn start is outstanding. Callers that
 * only care about that window (the web composer, the mobile outbox) use this
 * instead of widening {@link deriveThreadBusyState}'s inputs.
 */
export function hasPendingTurnStart(
  pendingTurnStart: OrchestrationPendingTurnStart | null | undefined,
): boolean {
  return pendingTurnStart != null;
}

/**
 * Whether a session event resolves an outstanding accepted turn start.
 *
 * The server projector, its SQL projection, and every client event reducer must
 * agree on this, otherwise a pending start the clients already retired keeps
 * rejecting new turns, or one they still hold rejects a send the server accepts.
 * Exactly two session shapes resolve a start:
 *
 *  - `running` with an active turn: the provider acknowledged the turn.
 *  - a terminal status with no active turn: the start ended without ever being
 *    acknowledged — the provider died, the session stopped, or turn start failed.
 *    Without this the pending start outlives the turn and wedges the thread
 *    forever, which is the bug this state exists to remove.
 *
 * `activeMessageId` is deliberately not part of this. The reactor stamps it on the
 * session *before* handing the turn to the provider, so treating it as
 * acknowledgement would retire the start before the provider ever saw the turn and
 * reopen the double-send hole. `ready`, `idle`, and `starting` are all
 * pre-acknowledgement and must not clear.
 */
export function sessionResolvesPendingTurnStart(session: {
  readonly status: string;
  readonly activeTurnId?: string | null;
}): boolean {
  if (session.activeTurnId !== null && session.activeTurnId !== undefined) {
    return session.status === "running";
  }
  return isTerminalOrchestrationSessionStatus(session.status);
}

/**
 * Session statuses that mean no turn is in progress.
 *
 * One definition, because a terminal status describes the *previous* turn. A new
 * start accepted while the session still carries one must not be read as already
 * resolved, which is why the reactor moves the session to `starting` when it
 * stamps a new start on top of a terminal status.
 */
export function isTerminalOrchestrationSessionStatus(status: string): boolean {
  return status === "error" || status === "stopped" || status === "interrupted";
}
