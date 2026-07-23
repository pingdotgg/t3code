import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import {
  shouldShowParentThinking,
  type ParentThinkingSignals,
} from "@t3tools/shared/parentThinking";

import type { ThreadFeedEntry } from "./threadActivity";

function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Scans the parent thread feed for signals that suppress the Thinking
 * indicator (streaming text, in-progress tools, visible reasoning).
 */
export function deriveParentThinkingFeedSignals(
  feed: ReadonlyArray<ThreadFeedEntry>,
): Pick<
  ParentThinkingSignals,
  | "hasActiveToolActivity"
  | "hasActiveStreamingAssistant"
  | "hasStreamingAssistantText"
  | "hasVisibleReasoningText"
> {
  let hasActiveToolActivity = false;
  let hasActiveStreamingAssistant = false;
  let hasStreamingAssistantText = false;
  let hasVisibleReasoningText = false;

  for (const entry of feed) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant" && entry.message.streaming) {
        hasActiveStreamingAssistant = true;
        if (isNonEmpty(entry.message.text)) {
          hasStreamingAssistantText = true;
        }
      }
      continue;
    }

    if (entry.type === "activity-group") {
      for (const activity of entry.activities) {
        // Neutral tool-like rows are filtered from the work-log display but
        // remain on the raw feed. Agent-icon neutral rows are thinking-tone
        // progress (task.progress); other neutrals are in-flight tools.
        if (activity.toolLike && activity.status === "neutral") {
          if (activity.icon === "agent" && isNonEmpty(activity.summary)) {
            hasVisibleReasoningText = true;
          } else if (activity.icon !== "agent") {
            hasActiveToolActivity = true;
          }
        }
      }
    }
  }

  return {
    hasActiveToolActivity,
    hasActiveStreamingAssistant,
    hasStreamingAssistantText,
    hasVisibleReasoningText,
  };
}

export function deriveShouldShowParentThinking(input: {
  readonly session: OrchestrationSession | null | undefined;
  readonly latestTurn: OrchestrationLatestTurn | null | undefined;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly hasPendingApproval?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly isStalled?: boolean;
}): boolean {
  const feedSignals = deriveParentThinkingFeedSignals(input.feed);
  return shouldShowParentThinking({
    sessionStatus: input.session?.status ?? null,
    latestTurnState: input.latestTurn?.state ?? null,
    hasPendingApproval: input.hasPendingApproval,
    hasPendingUserInput: input.hasPendingUserInput,
    isStalled: input.isStalled,
    ...feedSignals,
  });
}
