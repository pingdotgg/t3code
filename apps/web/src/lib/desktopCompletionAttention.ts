import type { OrchestrationLatestTurnState, OrchestrationSessionStatus } from "@t3tools/contracts";
import type { Thread } from "../types";

export interface CompletionAttentionState {
  activeTurnId: string | null;
  completedAt: string | null;
  isWorking: boolean;
  lastError: string | null;
  latestTurnState: OrchestrationLatestTurnState | null;
  sessionStatus: OrchestrationSessionStatus | null;
}

export function getCompletionAttentionState(
  thread: Pick<Thread, "latestTurn" | "session"> | undefined,
): CompletionAttentionState {
  return {
    activeTurnId: thread?.session?.activeTurnId ?? null,
    completedAt: thread?.latestTurn?.completedAt ?? null,
    isWorking:
      thread?.session?.orchestrationStatus === "starting" ||
      thread?.session?.orchestrationStatus === "running" ||
      thread?.latestTurn?.state === "running",
    lastError: thread?.session?.lastError ?? null,
    latestTurnState: thread?.latestTurn?.state ?? null,
    sessionStatus: thread?.session?.orchestrationStatus ?? null,
  };
}

export function shouldRequestCompletionAttention(
  previous: CompletionAttentionState | undefined,
  next: CompletionAttentionState,
): boolean {
  const completedTurnTransition =
    next.latestTurnState === "completed" &&
    next.completedAt !== null &&
    previous?.completedAt !== next.completedAt &&
    previous?.isWorking === true &&
    !next.isWorking;

  const sessionReadyTransition =
    previous?.isWorking === true &&
    previous.activeTurnId !== null &&
    next.sessionStatus === "ready" &&
    next.activeTurnId === null &&
    next.lastError === null;

  return completedTurnTransition || sessionReadyTransition;
}
