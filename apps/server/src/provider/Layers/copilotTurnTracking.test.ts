import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  recordTurnUsage,
  type CopilotTurnTrackingState,
} from "./copilotTurnTracking.ts";

function makeState(): CopilotTurnTrackingState {
  return {
    currentTurnId: undefined,
    currentProviderTurnId: undefined,
    pendingCompletionTurnId: undefined,
    pendingCompletionProviderTurnId: undefined,
    pendingTurnIds: [],
    pendingTurnUsage: undefined,
  };
}

describe("copilotTurnTracking", () => {
  it("keeps turn tracking alive until session.idle", () => {
    expect(isCopilotTurnTerminalEvent({ type: "assistant.usage" } as never)).toBe(false);
    expect(isCopilotTurnTerminalEvent({ type: "session.idle" } as never)).toBe(true);
    expect(isCopilotTurnTerminalEvent({ type: "abort" } as never)).toBe(true);
  });

  it("preserves usage details for the eventual turn completion event", () => {
    const state = makeState();
    state.pendingTurnIds.push(TurnId.makeUnsafe("turn-1"));

    beginCopilotTurn(state, TurnId.makeUnsafe("provider-turn-1"));
    recordTurnUsage(state, {
      model: "gpt-4.1",
      cost: 0.42,
      totalTokens: 123,
    } as never);
    markTurnAwaitingCompletion(state);

    expect(assistantUsageFields(state.pendingTurnUsage)).toEqual({
      usage: {
        model: "gpt-4.1",
        cost: 0.42,
        totalTokens: 123,
      },
      modelUsage: { model: "gpt-4.1" },
      totalCostUsd: 0.42,
    });

    clearTurnTracking(state);
    expect(state.pendingTurnUsage).toBeUndefined();
    expect(state.currentTurnId).toBeUndefined();
    expect(state.pendingCompletionTurnId).toBeUndefined();
  });
});
