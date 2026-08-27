import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import { derivePromptSuggestion, type PromptSuggestionSource } from "./promptSuggestion";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  overrides: Partial<Pick<OrchestrationThreadActivity, "turnId" | "createdAt">> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:10.000Z",
    ...overrides,
  };
}

function makeUserMessage(id: string, createdAt: string): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: "hello",
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeLatestTurn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-03-23T00:00:00.000Z",
    startedAt: "2026-03-23T00:00:00.000Z",
    completedAt: "2026-03-23T00:00:09.000Z",
    assistantMessageId: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<PromptSuggestionSource> = {}): PromptSuggestionSource {
  return {
    activities: [
      makeActivity("activity-1", "tool.completed", {}),
      makeActivity("activity-2", "prompt-suggestion", { suggestion: "  Run the tests  " }),
    ],
    messages: [makeUserMessage("message-1", "2026-03-23T00:00:00.000Z")],
    latestTurn: makeLatestTurn(),
    session: { status: "ready" },
    ...overrides,
  };
}

describe("derivePromptSuggestion", () => {
  it("returns the trimmed suggestion for the completed latest turn", () => {
    expect(derivePromptSuggestion(makeThread())).toBe("Run the tests");
  });

  it("uses the newest suggestion row", () => {
    expect(
      derivePromptSuggestion(
        makeThread({
          activities: [
            makeActivity("activity-1", "prompt-suggestion", { suggestion: "older" }),
            makeActivity("activity-2", "prompt-suggestion", { suggestion: "newer" }),
          ],
        }),
      ),
    ).toBe("newer");
  });

  it("returns null without a suggestion row", () => {
    expect(
      derivePromptSuggestion(
        makeThread({ activities: [makeActivity("activity-1", "tool.completed", {})] }),
      ),
    ).toBeNull();
  });

  it("returns null when the suggestion belongs to an earlier turn", () => {
    expect(
      derivePromptSuggestion(
        makeThread({ latestTurn: makeLatestTurn({ turnId: TurnId.make("turn-2") }) }),
      ),
    ).toBeNull();
  });

  it("returns null while the latest turn is still running", () => {
    expect(
      derivePromptSuggestion(makeThread({ latestTurn: makeLatestTurn({ state: "running" }) })),
    ).toBeNull();
    expect(derivePromptSuggestion(makeThread({ session: { status: "running" } }))).toBeNull();
    expect(derivePromptSuggestion(makeThread({ session: { status: "starting" } }))).toBeNull();
  });

  it("returns null once a newer user message exists", () => {
    expect(
      derivePromptSuggestion(
        makeThread({
          messages: [
            makeUserMessage("message-1", "2026-03-23T00:00:00.000Z"),
            makeUserMessage("message-2", "2026-03-23T00:00:11.000Z"),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a malformed or blank payload", () => {
    expect(
      derivePromptSuggestion(
        makeThread({ activities: [makeActivity("activity-1", "prompt-suggestion", {})] }),
      ),
    ).toBeNull();
    expect(
      derivePromptSuggestion(
        makeThread({
          activities: [makeActivity("activity-1", "prompt-suggestion", { suggestion: "   " })],
        }),
      ),
    ).toBeNull();
  });
});
