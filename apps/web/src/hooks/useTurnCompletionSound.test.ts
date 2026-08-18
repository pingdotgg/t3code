import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { detectNewTurnCompletions } from "./useTurnCompletionSound";

const envId = EnvironmentId.make("environment-local");
const projId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("provider-1");

function createMockThread(
  id: string,
  overrides?: Partial<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return {
    environmentId: envId,
    id: ThreadId.make(id),
    projectId: projId,
    title: `Thread ${id}`,
    modelSelection: {
      instanceId: providerInstanceId,
      model: "test-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-15T07:00:00.000Z",
    updatedAt: "2026-08-15T07:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("detectNewTurnCompletions", () => {
  it("does not trigger chime on initial snapshot or environment hydration of settled threads", () => {
    const thread = createMockThread("thread-1", {
      session: { status: "idle", activeTurnId: null, updatedAt: "2026-08-15T07:02:00.000Z" } as any,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-15T07:01:00.000Z",
        startedAt: "2026-08-15T07:01:01.000Z",
        completedAt: "2026-08-15T07:02:00.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

    const result = detectNewTurnCompletions([thread], {});
    expect(result.hasNewCompletion).toBe(false);
    expect(result.nextCompletions[key]).toBe("2026-08-15T07:02:00.000Z");
  });

  it("does not trigger chime during mid-turn checkpoints while state or session is running", () => {
    const thread = createMockThread("thread-1", {
      session: {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
        updatedAt: "2026-08-15T07:01:30.000Z",
      } as any,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-08-15T07:01:00.000Z",
        startedAt: "2026-08-15T07:01:01.000Z",
        completedAt: "2026-08-15T07:01:30.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

    const result = detectNewTurnCompletions([thread], {});
    expect(result.hasNewCompletion).toBe(false);
    expect(result.nextCompletions[key]).toBe("running");
  });

  it("triggers chime when a running thread settles and completes", () => {
    const thread = createMockThread("thread-1", {
      session: { status: "idle", activeTurnId: null, updatedAt: "2026-08-15T07:02:00.000Z" } as any,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-15T07:01:00.000Z",
        startedAt: "2026-08-15T07:01:01.000Z",
        completedAt: "2026-08-15T07:02:00.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const previous = { [key]: "running" };

    const result = detectNewTurnCompletions([thread], previous);
    expect(result.hasNewCompletion).toBe(true);
    expect(result.nextCompletions[key]).toBe("2026-08-15T07:02:00.000Z");
  });

  it("triggers chime when a previously completed thread completes a new turn", () => {
    const thread = createMockThread("thread-1", {
      session: { status: "idle", activeTurnId: null, updatedAt: "2026-08-15T07:06:00.000Z" } as any,
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-08-15T07:05:00.000Z",
        startedAt: "2026-08-15T07:05:01.000Z",
        completedAt: "2026-08-15T07:06:00.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const previous = { [key]: "2026-08-15T07:02:00.000Z" };

    const result = detectNewTurnCompletions([thread], previous);
    expect(result.hasNewCompletion).toBe(true);
    expect(result.nextCompletions[key]).toBe("2026-08-15T07:06:00.000Z");
  });

  it("ignores unchanged completed threads on subsequent renders", () => {
    const thread = createMockThread("thread-1", {
      session: { status: "idle", activeTurnId: null, updatedAt: "2026-08-15T07:06:00.000Z" } as any,
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-08-15T07:05:00.000Z",
        startedAt: "2026-08-15T07:05:01.000Z",
        completedAt: "2026-08-15T07:06:00.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const previous = { [key]: "2026-08-15T07:06:00.000Z" };

    const result = detectNewTurnCompletions([thread], previous);
    expect(result.hasNewCompletion).toBe(false);
  });

  it("clears tracked state when thread is archived and does not chime on unarchiving an already-settled thread", () => {
    const archivedThread = createMockThread("thread-1", {
      archivedAt: "2026-08-15T07:04:00.000Z",
      session: { status: "idle", activeTurnId: null, updatedAt: "2026-08-15T07:06:00.000Z" } as any,
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-08-15T07:05:00.000Z",
        startedAt: "2026-08-15T07:05:01.000Z",
        completedAt: "2026-08-15T07:06:00.000Z",
        assistantMessageId: null,
      },
    });
    const key = scopedThreadKey(scopeThreadRef(archivedThread.environmentId, archivedThread.id));
    const previous = { [key]: "running" };

    const archivedResult = detectNewTurnCompletions([archivedThread], previous);
    expect(archivedResult.hasNewCompletion).toBe(false);
    expect(archivedResult.nextCompletions[key]).toBeUndefined();

    const unarchivedThread = { ...archivedThread, archivedAt: null };
    const unarchivedResult = detectNewTurnCompletions(
      [unarchivedThread],
      archivedResult.nextCompletions,
    );
    expect(unarchivedResult.hasNewCompletion).toBe(false);
    expect(unarchivedResult.nextCompletions[key]).toBe("2026-08-15T07:06:00.000Z");
  });
});
