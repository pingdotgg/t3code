import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  countUnreadBackgroundThreads,
  isThreadUnreadBackground,
} from "./useUnreadBackgroundThreadCount";

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
    createdAt: "2026-08-14T20:00:00.000Z",
    updatedAt: "2026-08-14T20:00:00.000Z",
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

describe("isThreadUnreadBackground", () => {
  it("returns false for archived threads", () => {
    const thread = createMockThread("thread-1", {
      archivedAt: "2026-08-14T20:10:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(isThreadUnreadBackground(thread, undefined, null)).toBe(false);
  });

  it("returns false for the currently open route thread", () => {
    const thread = createMockThread("thread-1", {
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    expect(isThreadUnreadBackground(thread, "2026-08-14T20:00:00.000Z", threadKey)).toBe(false);
  });

  it("returns true when turn completed after last visited timestamp", () => {
    const thread = createMockThread("thread-1", {
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(isThreadUnreadBackground(thread, "2026-08-14T20:05:00.000Z", "other-thread")).toBe(true);
  });

  it("returns false when last visited timestamp is newer than turn completion", () => {
    const thread = createMockThread("thread-1", {
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(isThreadUnreadBackground(thread, "2026-08-14T20:07:00.000Z", "other-thread")).toBe(
      false,
    );
  });

  it("returns false when thread was never visited", () => {
    const thread = createMockThread("thread-1", {
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(isThreadUnreadBackground(thread, undefined, "other-thread")).toBe(false);
  });
});

describe("countUnreadBackgroundThreads", () => {
  it("counts only unread background threads", () => {
    const thread1 = createMockThread("thread-1", {
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-14T20:05:00.000Z",
        startedAt: "2026-08-14T20:05:01.000Z",
        completedAt: "2026-08-14T20:06:00.000Z",
        assistantMessageId: null,
      },
    });
    const thread2 = createMockThread("thread-2", {
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-08-14T20:10:00.000Z",
        startedAt: "2026-08-14T20:10:01.000Z",
        completedAt: "2026-08-14T20:11:00.000Z",
        assistantMessageId: null,
      },
    });
    const thread3 = createMockThread("thread-3");

    const key1 = scopedThreadKey(scopeThreadRef(thread1.environmentId, thread1.id));
    const key2 = scopedThreadKey(scopeThreadRef(thread2.environmentId, thread2.id));

    const visits = {
      [key1]: "2026-08-14T20:05:00.000Z",
      [key2]: "2026-08-14T20:15:00.000Z",
    };

    expect(countUnreadBackgroundThreads([thread1, thread2, thread3], visits, "active-thread")).toBe(
      1,
    );
    expect(countUnreadBackgroundThreads([thread1, thread2, thread3], visits, key1)).toBe(0);
  });
});
