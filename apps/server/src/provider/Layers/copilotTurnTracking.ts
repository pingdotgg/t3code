import { TurnId } from "@t3tools/contracts";
import type { SessionEvent } from "@github/copilot-sdk";

export type CopilotAssistantUsage = Extract<SessionEvent, { type: "assistant.usage" }>["data"];

export interface CopilotTurnTrackingState {
  currentTurnId: TurnId | undefined;
  currentProviderTurnId: TurnId | undefined;
  pendingCompletionTurnId: TurnId | undefined;
  pendingCompletionProviderTurnId: TurnId | undefined;
  pendingTurnIds: Array<TurnId>;
  pendingTurnUsage: CopilotAssistantUsage | undefined;
}

export function completionTurnRefs(state: CopilotTurnTrackingState) {
  return {
    turnId: state.pendingCompletionTurnId ?? state.currentTurnId,
    providerTurnId: state.pendingCompletionProviderTurnId ?? state.currentProviderTurnId,
  };
}

export function beginCopilotTurn(
  state: CopilotTurnTrackingState,
  providerTurnId: TurnId,
): void {
  state.pendingCompletionTurnId = undefined;
  state.pendingCompletionProviderTurnId = undefined;
  state.pendingTurnUsage = undefined;
  state.currentProviderTurnId = providerTurnId;
  state.currentTurnId = state.pendingTurnIds.shift() ?? state.currentTurnId ?? providerTurnId;
}

export function markTurnAwaitingCompletion(state: CopilotTurnTrackingState): void {
  state.pendingCompletionTurnId = state.currentTurnId ?? state.pendingCompletionTurnId;
  state.pendingCompletionProviderTurnId =
    state.currentProviderTurnId ?? state.pendingCompletionProviderTurnId;
}

export function recordTurnUsage(
  state: CopilotTurnTrackingState,
  usage: CopilotAssistantUsage,
): void {
  state.pendingTurnUsage = usage;
}

export function clearTurnTracking(state: CopilotTurnTrackingState): void {
  state.currentTurnId = undefined;
  state.currentProviderTurnId = undefined;
  state.pendingCompletionTurnId = undefined;
  state.pendingCompletionProviderTurnId = undefined;
  state.pendingTurnUsage = undefined;
}

export function assistantUsageFields(
  usage: CopilotAssistantUsage | undefined,
): {
  usage?: CopilotAssistantUsage;
  modelUsage?: { model: string };
  totalCostUsd?: number;
} {
  if (!usage) {
    return {};
  }

  return {
    usage,
    ...(usage.cost !== undefined ? { totalCostUsd: usage.cost } : {}),
    ...(usage.model ? { modelUsage: { model: usage.model } } : {}),
  };
}

export function isCopilotTurnTerminalEvent(event: SessionEvent): boolean {
  return event.type === "abort" || event.type === "session.idle";
}
