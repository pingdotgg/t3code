import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileSideChatMenuItems,
  canForkMobileAssistantMessage,
  visibleTopLevelThreads,
} from "./sideChats.logic";

const latestTurn = {
  turnId: TurnId.make("turn-2"),
  state: "completed" as const,
  requestedAt: "2026-09-03T12:00:00.000Z",
  startedAt: "2026-09-03T12:00:01.000Z",
  completedAt: "2026-09-03T12:00:02.000Z",
  assistantMessageId: MessageId.make("message-2"),
};

describe("mobile side-chat list helpers", () => {
  it("hides side chats from top-level lists", () => {
    expect(
      visibleTopLevelThreads([{ id: "main" }, { id: "side", sideChat: true }]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["main"]);
  });

  it("lists child side chats for the parent thread menu", () => {
    expect(
      buildMobileSideChatMenuItems({
        sideChats: [
          { id: ThreadId.make("side-1"), title: "Try another approach" },
          { id: ThreadId.make("side-2"), title: "Check the tests" },
        ] as ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "title">>,
      }),
    ).toEqual([
      { id: "side-chat:side-1", title: "Try another approach" },
      { id: "side-chat:side-2", title: "Check the tests" },
    ]);
  });
});

describe("mobile message fork availability", () => {
  it("matches any-turn and latest-turn provider boundaries", () => {
    expect(
      canForkMobileAssistantMessage({
        capability: "any-turn",
        completed: true,
        messageTurnId: TurnId.make("turn-1"),
        latestTurn,
      }),
    ).toBe(true);
    expect(
      canForkMobileAssistantMessage({
        capability: "latest-turn",
        completed: true,
        messageTurnId: TurnId.make("turn-1"),
        latestTurn,
      }),
    ).toBe(false);
    expect(
      canForkMobileAssistantMessage({
        capability: "latest-turn",
        completed: true,
        messageTurnId: latestTurn.turnId,
        latestTurn,
      }),
    ).toBe(true);
  });

  it("rejects a failed or interrupted latest turn for any-turn providers", () => {
    for (const state of ["error", "interrupted"] as const) {
      expect(
        canForkMobileAssistantMessage({
          capability: "any-turn",
          completed: true,
          messageTurnId: latestTurn.turnId,
          latestTurn: { ...latestTurn, state },
        }),
      ).toBe(false);
    }
  });
});
