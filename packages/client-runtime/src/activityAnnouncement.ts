import type { OrchestrationLatestTurn, OrchestrationLatestTurnState } from "@t3tools/contracts";

/** The parts of a viewed thread that screen reader announcements react to. */
export interface ActivityAnnouncementState {
  readonly threadKey: string;
  readonly working: boolean;
  readonly turnId: string | null;
  readonly turnState: OrchestrationLatestTurnState | null;
  readonly turnRequestedAt: string | null;
  readonly approvalRequestId: string | null;
  readonly userInputRequestId: string | null;
}

export function activityAnnouncementTurnFields(latestTurn: OrchestrationLatestTurn | null) {
  return {
    turnId: latestTurn?.turnId ?? null,
    turnState: latestTurn?.state ?? null,
    turnRequestedAt: latestTurn?.requestedAt ?? null,
  };
}

const turnEndMessages = {
  completed: "Response complete",
  interrupted: "Response stopped",
  error: "Response failed",
} as const;

function endedTurnState(previous: ActivityAnnouncementState, next: ActivityAnnouncementState) {
  if (next.turnId === null || next.turnState === null || next.turnState === "running") return null;
  if (next.turnId === previous.turnId) {
    return previous.turnState === "running" ? next.turnState : null;
  }
  // A short turn, or one started from another device, can start and finish
  // between two renders, so its running state is never seen. Count it when it
  // is newer than the last turn seen, so reverting to an older turn stays
  // silent. With no earlier turn to compare, only count it if work was under
  // way, so loading the thread's history stays silent.
  const newer =
    previous.turnRequestedAt === null
      ? previous.working
      : next.turnRequestedAt !== null && next.turnRequestedAt > previous.turnRequestedAt;
  return newer ? next.turnState : null;
}

/**
 * The status messages for a change between two renders of the viewed thread,
 * in the order they happened; empty when nothing worth speaking changed. Only
 * state transitions qualify, never streamed content. Opening or switching
 * threads is silent: the screen already shows that state.
 */
export function activityAnnouncementMessages(
  previous: ActivityAnnouncementState | null,
  next: ActivityAnnouncementState,
): string[] {
  if (previous === null || previous.threadKey !== next.threadKey) return [];

  const messages: string[] = [];
  if (!previous.working && next.working) messages.push("Agent working");
  const ended = endedTurnState(previous, next);
  if (ended !== null) messages.push(turnEndMessages[ended]);
  // Keyed on request id so a second request right after the first is still
  // announced, while re-renders of the same request are not.
  if (next.approvalRequestId !== null && next.approvalRequestId !== previous.approvalRequestId) {
    messages.push("Approval needed");
  }
  if (next.userInputRequestId !== null && next.userInputRequestId !== previous.userInputRequestId) {
    messages.push("Question from agent");
  }
  return messages;
}
