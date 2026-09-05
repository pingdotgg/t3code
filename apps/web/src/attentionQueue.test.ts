import { describe, expect, it } from "vite-plus/test";

import {
  resolveNextAttentionThreadKey,
  resolveThreadAttention,
  sortAttentionItems,
} from "./attentionQueue";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ThreadId, TurnId } from "@t3tools/contracts";

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: "environment-1",
    projectId: "project-1",
    title: "Thread 1",
    modelSelection: {} as EnvironmentThreadShell["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("thread attention queue", () => {
  it("recognizes a completion newer than the last visit", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-09-04T10:00:00.000Z",
        startedAt: "2026-09-04T10:01:00.000Z",
        completedAt: "2026-09-04T10:02:00.000Z",
        assistantMessageId: null,
      },
      updatedAt: "2026-09-04T10:02:00.000Z",
    });

    expect(
      resolveThreadAttention({
        thread,
        threadKey: "environment-1:thread-1",
        lastVisitedAt: "2026-09-04T10:01:00.000Z",
        acknowledgedAttentionKey: undefined,
      })?.state,
    ).toBe("ready");
  });

  it("keeps an acknowledged pending request out until its timestamp changes", () => {
    const thread = makeThread({
      hasPendingUserInput: true,
      updatedAt: "2026-09-04T10:03:00.000Z",
    });
    const item = resolveThreadAttention({
      thread,
      threadKey: "environment-1:thread-1",
      lastVisitedAt: undefined,
      acknowledgedAttentionKey: "input:2026-09-04T10:03:00.000Z",
    });

    expect(item).toBeNull();
  });

  it("orders newest attention first and advances with wraparound", () => {
    const items = sortAttentionItems(
      [
        resolveThreadAttention({
          thread: makeThread({
            id: ThreadId.make("old"),
            updatedAt: "2026-09-04T10:01:00.000Z",
            hasPendingUserInput: true,
          }),
          threadKey: "environment-1:old",
          lastVisitedAt: undefined,
          acknowledgedAttentionKey: undefined,
        })!,
        resolveThreadAttention({
          thread: makeThread({
            id: ThreadId.make("new"),
            updatedAt: "2026-09-04T10:02:00.000Z",
            hasPendingUserInput: true,
          }),
          threadKey: "environment-1:new",
          lastVisitedAt: undefined,
          acknowledgedAttentionKey: undefined,
        })!,
      ].filter(Boolean),
    );

    expect(items.map((item) => item.threadKey)).toEqual(["environment-1:new", "environment-1:old"]);
    expect(resolveNextAttentionThreadKey({ items, currentThreadKey: "environment-1:old" })).toBe(
      "environment-1:new",
    );
  });
});
