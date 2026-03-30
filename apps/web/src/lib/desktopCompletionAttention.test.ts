import { describe, expect, it } from "vitest";

import {
  getCompletionAttentionState,
  shouldRequestCompletionAttention,
} from "./desktopCompletionAttention";
import type { Thread } from "../types";
import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

function makeThread(overrides?: Partial<Pick<Thread, "latestTurn" | "session">>): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-30T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-30T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeRunningThread(): Thread {
  return makeThread({
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TurnId.makeUnsafe("turn-1"),
      createdAt: "2026-03-30T10:00:00.000Z",
      updatedAt: "2026-03-30T10:00:01.000Z",
    },
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "running",
      requestedAt: "2026-03-30T10:00:00.000Z",
      startedAt: "2026-03-30T10:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  });
}

describe("shouldRequestCompletionAttention", () => {
  it("requests attention when a working thread completes", () => {
    const previous = getCompletionAttentionState(makeRunningThread());
    const next = getCompletionAttentionState(
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-03-30T10:00:00.000Z",
          updatedAt: "2026-03-30T10:00:04.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-03-30T10:00:00.000Z",
          startedAt: "2026-03-30T10:00:01.000Z",
          completedAt: "2026-03-30T10:00:04.000Z",
          assistantMessageId: null,
        },
      }),
    );

    expect(shouldRequestCompletionAttention(previous, next)).toBe(true);
  });

  it("does not request attention on initial hydration of completed threads", () => {
    const next = getCompletionAttentionState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-03-30T10:00:00.000Z",
          startedAt: "2026-03-30T10:00:01.000Z",
          completedAt: "2026-03-30T10:00:04.000Z",
          assistantMessageId: null,
        },
      }),
    );

    expect(shouldRequestCompletionAttention(undefined, next)).toBe(false);
  });

  it("does not request attention for repeated completed snapshots", () => {
    const completedThread = getCompletionAttentionState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-03-30T10:00:00.000Z",
          startedAt: "2026-03-30T10:00:01.000Z",
          completedAt: "2026-03-30T10:00:04.000Z",
          assistantMessageId: null,
        },
      }),
    );

    expect(shouldRequestCompletionAttention(completedThread, completedThread)).toBe(false);
  });

  it("does not request attention when a turn errors", () => {
    const previous = getCompletionAttentionState(makeRunningThread());
    const next = getCompletionAttentionState(
      makeThread({
        session: {
          provider: "codex",
          status: "error",
          orchestrationStatus: "error",
          createdAt: "2026-03-30T10:00:00.000Z",
          updatedAt: "2026-03-30T10:00:04.000Z",
          lastError: "boom",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "error",
          requestedAt: "2026-03-30T10:00:00.000Z",
          startedAt: "2026-03-30T10:00:01.000Z",
          completedAt: "2026-03-30T10:00:04.000Z",
          assistantMessageId: null,
        },
      }),
    );

    expect(shouldRequestCompletionAttention(previous, next)).toBe(false);
  });

  it("requests attention when a running session becomes ready without a latest completed turn", () => {
    const previous = getCompletionAttentionState(makeRunningThread());
    const next = getCompletionAttentionState(
      makeThread({
        session: {
          provider: "claudeAgent",
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          createdAt: "2026-03-30T10:00:00.000Z",
          updatedAt: "2026-03-30T10:00:04.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-03-30T10:00:00.000Z",
          startedAt: "2026-03-30T10:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    expect(shouldRequestCompletionAttention(previous, next)).toBe(true);
  });
});
