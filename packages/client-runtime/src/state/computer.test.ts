import type { ComputerApproval, ComputerTaskView } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { type ComputerActivityEntry, computerStripEntries } from "./computer.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const owner = ThreadId.make("thread-owner");
const other = ThreadId.make("thread-other");

const entry = (environmentId: EnvironmentId, threadId: ThreadId): ComputerActivityEntry => ({
  environmentId,
  environmentLabel: environmentId,
  task: { taskId: `cu_${environmentId}_${threadId}`, threadId } as unknown as ComputerTaskView,
  approvals: [{ id: `ap_${environmentId}_${threadId}` } as unknown as ComputerApproval],
});

describe("computerStripEntries", () => {
  const activity = [entry(local, owner), entry(local, other), entry(remote, owner)];

  it.each([
    { name: "no thread on screen keeps every card", viewing: null, cards: [1, 1, 1] },
    {
      name: "the owning thread keeps its row with Stop and drops its card",
      viewing: { environmentId: local, threadId: owner },
      cards: [0, 1, 1],
    },
    {
      name: "the same thread id in another environment is another thread",
      viewing: { environmentId: remote, threadId: owner },
      cards: [1, 1, 0],
    },
  ])("$name", ({ viewing, cards }) => {
    const rows = computerStripEntries(activity, viewing);
    expect(rows.map((row) => row.task.taskId)).toEqual(activity.map((row) => row.task.taskId));
    expect(rows.map((row) => row.approvals.length)).toEqual(cards);
  });

  it("returns the same array when the open thread has no card", () => {
    expect(
      computerStripEntries(activity, { environmentId: local, threadId: ThreadId.make("x") }),
    ).toBe(activity);
  });
});
