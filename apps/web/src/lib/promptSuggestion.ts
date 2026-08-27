import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

/** Activity kind the server appends for a provider's predicted next prompt. */
export const PROMPT_SUGGESTION_ACTIVITY_KIND = "prompt-suggestion";

export interface PromptSuggestionSource {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
}

function suggestionFromActivity(activity: OrchestrationThreadActivity): string | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const suggestion = payload?.suggestion;
  if (typeof suggestion !== "string") {
    return null;
  }
  const trimmed = suggestion.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The provider's predicted next prompt for the thread's latest turn, or null
 * when there is none or it is stale.
 *
 * A suggestion only makes sense at the moment the turn it was generated for
 * has settled and nothing newer has happened: the latest turn must be the
 * suggestion's turn and completed, the session must not be running, and no
 * user message may have been sent after the suggestion arrived.
 */
export function derivePromptSuggestion(thread: PromptSuggestionSource): string | null {
  const latestTurn = thread.latestTurn;
  if (!latestTurn || latestTurn.state !== "completed") {
    return null;
  }
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "running" || sessionStatus === "starting") {
    return null;
  }

  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index];
    if (!activity || activity.kind !== PROMPT_SUGGESTION_ACTIVITY_KIND) {
      continue;
    }
    if (activity.turnId !== latestTurn.turnId) {
      return null;
    }
    const suggestion = suggestionFromActivity(activity);
    if (suggestion === null) {
      return null;
    }
    const supersededByUserMessage = thread.messages.some(
      (message) => message.role === "user" && message.createdAt > activity.createdAt,
    );
    return supersededByUserMessage ? null : suggestion;
  }
  return null;
}
