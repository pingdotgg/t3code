import type { OrchestrationPendingTurnStart } from "@t3tools/contracts";

/**
 * Acceptance and provider acknowledgement are separate commits, so `latestTurn`
 * and the session stay idle until the provider answers. `pendingTurnStart` covers
 * that window. Timestamps cannot substitute: a stop can share a message's
 * millisecond with its terminal turn, and a fork or checkpoint-less turn leaves no
 * completed turn to compare against, which wedged threads permanently.
 */
export type ThreadBusyState = "idle" | "pending" | "running";

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

export function hasPendingTurnStart(
  pendingTurnStart: OrchestrationPendingTurnStart | null | undefined,
): boolean {
  return pendingTurnStart != null;
}

/**
 * `activeMessageId` is deliberately excluded: the reactor stamps it before handing
 * the turn to the provider, so counting it as acknowledgement retires the start
 * early and reopens the double-send hole.
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

/** A terminal status describes the *previous* turn, so a new start must clear it. */
export function isTerminalOrchestrationSessionStatus(status: string): boolean {
  return status === "error" || status === "stopped" || status === "interrupted";
}
