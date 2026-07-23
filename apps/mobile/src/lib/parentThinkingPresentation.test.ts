import { describe, expect, it } from "vite-plus/test";
import type { MessageId, TurnId } from "@t3tools/contracts";

import {
  deriveParentThinkingFeedSignals,
  deriveShouldShowParentThinking,
} from "./parentThinkingPresentation";
import type { ThreadFeedEntry } from "./threadActivity";

const turnId = "turn-1" as TurnId;

function assistantMessage(input: {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}): ThreadFeedEntry {
  return {
    type: "message",
    id: input.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: input.id as MessageId,
      role: "assistant",
      text: input.text,
      streaming: input.streaming,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      turnId,
    },
  };
}

describe("deriveParentThinkingFeedSignals", () => {
  it("detects streaming assistant messages", () => {
    expect(
      deriveParentThinkingFeedSignals([assistantMessage({ id: "a1", text: "", streaming: true })]),
    ).toEqual({
      hasActiveToolActivity: false,
      hasActiveStreamingAssistant: true,
      hasStreamingAssistantText: false,
      hasVisibleReasoningText: false,
    });

    expect(
      deriveParentThinkingFeedSignals([
        assistantMessage({ id: "a1", text: "Hello", streaming: true }),
      ]),
    ).toMatchObject({
      hasActiveStreamingAssistant: true,
      hasStreamingAssistantText: true,
    });
  });

  it("detects in-progress tools via neutral tool-like rows", () => {
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "g1",
        createdAt: "2026-01-01T00:00:00.000Z",
        turnId,
        activities: [
          {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            turnId,
            summary: "Bash",
            detail: "ls",
            fullDetail: null,
            copyText: "ls",
            icon: "command",
            toolLike: true,
            status: "neutral",
          },
        ],
      },
    ];
    expect(deriveParentThinkingFeedSignals(feed).hasActiveToolActivity).toBe(true);
  });
});

describe("deriveShouldShowParentThinking", () => {
  it("shows while the session is running with a quiet feed", () => {
    expect(
      deriveShouldShowParentThinking({
        session: { status: "running" } as never,
        latestTurn: { state: "running" } as never,
        feed: [],
      }),
    ).toBe(true);
  });

  it("hides while streaming or during tools", () => {
    expect(
      deriveShouldShowParentThinking({
        session: { status: "running" } as never,
        latestTurn: { state: "running" } as never,
        feed: [assistantMessage({ id: "a1", text: "…", streaming: true })],
      }),
    ).toBe(false);

    const toolFeed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "g1",
        createdAt: "2026-01-01T00:00:00.000Z",
        turnId,
        activities: [
          {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            turnId,
            summary: "Bash",
            detail: "ls",
            fullDetail: null,
            copyText: "ls",
            icon: "command",
            toolLike: true,
            status: "neutral",
          },
        ],
      },
    ];
    expect(
      deriveShouldShowParentThinking({
        session: { status: "running" } as never,
        latestTurn: { state: "running" } as never,
        feed: toolFeed,
      }),
    ).toBe(false);
  });

  it("hides when stalled or waiting for approval", () => {
    expect(
      deriveShouldShowParentThinking({
        session: { status: "running" } as never,
        latestTurn: { state: "running" } as never,
        feed: [],
        isStalled: true,
      }),
    ).toBe(false);
    expect(
      deriveShouldShowParentThinking({
        session: { status: "running" } as never,
        latestTurn: { state: "running" } as never,
        feed: [],
        hasPendingApproval: true,
      }),
    ).toBe(false);
  });
});
