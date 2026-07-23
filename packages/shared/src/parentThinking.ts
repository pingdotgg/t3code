/**
 * Whether the parent agent should show an ephemeral "Thinking…" indicator.
 *
 * Authoritative runtime state is the only entry gate: the session/turn must
 * report active work. Visible model output (streamed assistant text), tool
 * execution, waiting/compaction, approvals, stalls, and terminal outcomes all
 * suppress the indicator so it never competes with a more specific state and
 * never floods the transcript with repeated entries.
 */

export type ParentThinkingSignals = {
  /** Orchestration session status (`running`, `waiting`, `idle`, …). */
  readonly sessionStatus: string | null | undefined;
  /** Latest turn state (`running`, `completed`, `error`, `interrupted`, …). */
  readonly latestTurnState: string | null | undefined;
  readonly hasPendingApproval?: boolean;
  readonly hasPendingUserInput?: boolean;
  /** Server-authoritative stall from `session.health`. */
  readonly isStalled?: boolean;
  /** Parent-thread tool call currently in progress. */
  readonly hasActiveToolActivity?: boolean;
  /**
   * An assistant message is streaming (empty or not). The stream row itself
   * communicates progress, including the empty-placeholder case.
   */
  readonly hasActiveStreamingAssistant?: boolean;
  /** Non-empty streamed assistant body for the active turn. */
  readonly hasStreamingAssistantText?: boolean;
  /** Visible reasoning/progress text for the parent agent. */
  readonly hasVisibleReasoningText?: boolean;
};

/**
 * True when the parent model is actively reasoning without other visible
 * activity the UI already surfaces.
 */
export function shouldShowParentThinking(signals: ParentThinkingSignals): boolean {
  if (signals.hasPendingApproval || signals.hasPendingUserInput) {
    return false;
  }
  if (signals.isStalled) {
    return false;
  }

  const sessionStatus = signals.sessionStatus ?? null;
  const latestTurnState = signals.latestTurnState ?? null;

  // Waiting covers sleep/wake and provider compaction (Claude reports
  // compacting as session waiting). Error/interrupted/stopped are terminal.
  if (
    sessionStatus === "waiting" ||
    sessionStatus === "error" ||
    sessionStatus === "interrupted" ||
    sessionStatus === "stopped" ||
    sessionStatus === "idle" ||
    sessionStatus === "ready"
  ) {
    return false;
  }
  if (
    latestTurnState === "error" ||
    latestTurnState === "interrupted" ||
    latestTurnState === "completed"
  ) {
    // Still allow when the session itself remains running (e.g. turn flipped
    // while the next turn is spinning up), but only via sessionStatus below.
    if (sessionStatus !== "running" && sessionStatus !== "starting") {
      return false;
    }
  }

  const turnActive =
    sessionStatus === "running" || sessionStatus === "starting" || latestTurnState === "running";
  if (!turnActive) {
    return false;
  }

  if (signals.hasActiveToolActivity) {
    return false;
  }
  if (signals.hasActiveStreamingAssistant || signals.hasStreamingAssistantText) {
    return false;
  }
  if (signals.hasVisibleReasoningText) {
    return false;
  }

  return true;
}
