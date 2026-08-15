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
  const sessionStart = Date.parse("2026-08-15T07:00:00.000Z");

  it("returns hasNewCompletion false when completions are unchanged", () => {
    const thread = createMockThread("thread-1", {
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
    const previous = { [key]: "2026-08-15T07:02:00.000Z" };

    const result = detectNewTurnCompletions([thread], previous, sessionStart);
    expect(result.hasNewCompletion).toBe(false);
  });

  it("returns hasNewCompletion true when a thread receives a new completion timestamp", () => {
    const thread = createMockThread("thread-1", {
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

    const result = detectNewTurnCompletions([thread], previous, sessionStart);
    expect(result.hasNewCompletion).toBe(true);
    expect(result.nextCompletions[key]).toBe("2026-08-15T07:06:00.000Z");
  });

  it("ignores archived threads", () => {
    const thread = createMockThread("thread-1", {
      archivedAt: "2026-08-15T07:04:00.000Z",
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

    const result = detectNewTurnCompletions([thread], previous, sessionStart);
    expect(result.hasNewCompletion).toBe(false);
  });
});
