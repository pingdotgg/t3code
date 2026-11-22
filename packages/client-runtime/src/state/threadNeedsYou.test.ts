import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { selectNeedsYouThreads } from "./threadNeedsYou.ts";

const environmentId = EnvironmentId.make("environment-local");

type Fixture = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "archivedAt"
  | "lineage"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
>;

function thread(id: string, overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: ThreadId.make(id),
    environmentId,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    ...overrides,
  } as Fixture;
}

describe("selectNeedsYouThreads", () => {
  it("lists every thread blocked on the user, approvals first, past settle and snooze, skipping archived and delegated work", () => {
    const threads = [
      thread("idle"),
      thread("question", { hasPendingUserInput: true }),
      // Settled and snoozed rows leave the list, but an approval still needs the user.
      {
        ...thread("approval", { hasPendingApprovals: true }),
        settledOverride: "settled" as const,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      },
      thread("guest", { pendingGuestMessageCount: 2 }),
      thread("subagent-approval", { pendingSubagentRequest: "approval" }),
      thread("archived", { hasPendingApprovals: true, archivedAt: "2026-03-09T10:00:00.000Z" }),
      thread("subagent", {
        hasPendingApprovals: true,
        lineage: {
          rootThreadId: ThreadId.make("question"),
          parentThreadId: ThreadId.make("question"),
          relationshipToParent: "subagent",
        },
      } as Partial<Fixture>),
      thread("delegated", { hasPendingUserInput: true }),
    ];
    const delegated = new Set([threadKey({ environmentId, threadId: ThreadId.make("delegated") })]);

    expect(
      selectNeedsYouThreads(threads, delegated).map(({ thread, reason }) => [thread.id, reason]),
    ).toEqual([
      ["approval", "approval"],
      ["subagent-approval", "approval"],
      ["question", "input"],
      ["guest", "request"],
    ]);
  });
});
