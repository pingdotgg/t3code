import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  MessageId,
  type OrchestrationSession,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileSideChatMenuItems,
  canForkMobileAssistantMessage,
  completedTurnIdsFromCheckpoints,
  type ForkCapabilityConfig,
  resolveMobileThreadForkCapability,
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
  it("hides side chats whose parent is still known", () => {
    const parentId = ThreadId.make("main");
    expect(
      visibleTopLevelThreads(
        [
          { id: parentId },
          {
            id: ThreadId.make("side"),
            sideChat: true,
            fork: {
              sourceThreadId: parentId,
              sourceTurnId: null,
              sourceMessageId: null,
              forkedAt: "2026-09-03T12:00:00.000Z",
            },
          },
        ],
        new Set([parentId, ThreadId.make("side")]),
      ).map((thread) => thread.id),
    ).toEqual([parentId]);
  });

  it("shows orphaned side chats in top-level lists", () => {
    const sideChatId = ThreadId.make("side");
    expect(
      visibleTopLevelThreads(
        [
          {
            id: sideChatId,
            sideChat: true,
            fork: {
              sourceThreadId: ThreadId.make("missing-parent"),
              sourceTurnId: null,
              sourceMessageId: null,
              forkedAt: "2026-09-03T12:00:00.000Z",
            },
          },
        ],
        new Set([sideChatId]),
      ).map((thread) => thread.id),
    ).toEqual([sideChatId]);
  });

  it("lists child side chats for the parent thread menu", () => {
    expect(
      buildMobileSideChatMenuItems({
        sideChats: [
          { id: ThreadId.make("side-1"), title: "Try another approach" },
          { id: ThreadId.make("side-2"), title: "Check the tests" },
        ] satisfies ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "title">>,
      }),
    ).toEqual([
      { id: "side-chat:side-1", title: "Try another approach" },
      { id: "side-chat:side-2", title: "Check the tests" },
    ]);
  });
});

describe("mobile thread fork capability", () => {
  const serverConfig = {
    providers: [
      { instanceId: ProviderInstanceId.make("claude"), sessionFork: "latest-turn" },
      { instanceId: ProviderInstanceId.make("codex-work"), sessionFork: "any-turn" },
    ],
  } satisfies ForkCapabilityConfig;
  const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" };
  const session = (status: OrchestrationSession["status"]) =>
    ({
      threadId: ThreadId.make("thread"),
      status,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex-work"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-03T12:00:00.000Z",
    }) satisfies OrchestrationSession;

  it("follows a live session's instance and falls back to the stored selection otherwise", () => {
    expect(resolveMobileThreadForkCapability({ modelSelection, session: null }, serverConfig)).toBe(
      "latest-turn",
    );
    expect(
      resolveMobileThreadForkCapability(
        { modelSelection, session: session("ready") },
        serverConfig,
      ),
    ).toBe("any-turn");
    expect(
      resolveMobileThreadForkCapability(
        { modelSelection, session: session("stopped") },
        serverConfig,
      ),
    ).toBe("latest-turn");
    expect(
      resolveMobileThreadForkCapability(
        { modelSelection, session: session("error") },
        serverConfig,
      ),
    ).toBe("latest-turn");
  });
});

describe("mobile message fork availability", () => {
  it("matches any-turn and latest-turn provider boundaries", () => {
    expect(
      canForkMobileAssistantMessage({
        capability: "any-turn",
        completed: true,
        completedTurnIds: new Set([TurnId.make("turn-1")]),
        messageTurnId: TurnId.make("turn-1"),
        latestTurn,
      }),
    ).toBe(true);
    expect(
      canForkMobileAssistantMessage({
        capability: "latest-turn",
        completed: true,
        completedTurnIds: new Set(),
        messageTurnId: TurnId.make("turn-1"),
        latestTurn,
      }),
    ).toBe(false);
    expect(
      canForkMobileAssistantMessage({
        capability: "latest-turn",
        completed: true,
        completedTurnIds: new Set(),
        messageTurnId: latestTurn.turnId,
        latestTurn,
      }),
    ).toBe(true);
  });

  it("derives completed turns only from ready checkpoints", () => {
    expect(
      completedTurnIdsFromCheckpoints([
        { turnId: TurnId.make("turn-ready"), status: "ready" },
        { turnId: TurnId.make("turn-missing"), status: "missing" },
        { turnId: TurnId.make("turn-error"), status: "error" },
      ]),
    ).toEqual(new Set([TurnId.make("turn-ready")]));
  });

  it("requires a ready checkpoint for earlier any-turn responses", () => {
    expect(
      canForkMobileAssistantMessage({
        capability: "any-turn",
        completed: true,
        completedTurnIds: new Set(),
        messageTurnId: TurnId.make("turn-1"),
        latestTurn,
      }),
    ).toBe(false);
  });

  it("forks the latest completed any-turn response before its checkpoint is ready", () => {
    expect(
      canForkMobileAssistantMessage({
        capability: "any-turn",
        completed: true,
        completedTurnIds: new Set(),
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
          completedTurnIds: new Set([latestTurn.turnId]),
          messageTurnId: latestTurn.turnId,
          latestTurn: { ...latestTurn, state },
        }),
      ).toBe(false);
    }
  });
});
