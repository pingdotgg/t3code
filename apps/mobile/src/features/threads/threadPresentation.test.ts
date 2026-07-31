import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

function makeCompletedThread(): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Completed thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-06-01T12:00:00.000Z",
      startedAt: "2026-06-01T12:00:01.000Z",
      completedAt: "2026-06-01T12:01:00.000Z",
      assistantMessageId: MessageId.make("assistant-1"),
    },
    createdAt: "2026-06-01T11:00:00.000Z",
    updatedAt: "2026-06-01T12:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-06-01T12:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("resolveThreadStatus completion state", () => {
  it("shows Done after a turn completes while the thread is away", () => {
    expect(resolveThreadStatus(makeCompletedThread(), "2026-06-01T12:00:30.000Z")).toMatchObject({
      kind: "done",
      label: "Done",
    });
  });

  it("clears Done once the completion has been visited", () => {
    expect(resolveThreadStatus(makeCompletedThread(), "2026-06-01T12:01:00.000Z")).toBeNull();
  });

  it("does not mark existing history unread on first launch", () => {
    expect(resolveThreadStatus(makeCompletedThread())).toBeNull();
  });
});
