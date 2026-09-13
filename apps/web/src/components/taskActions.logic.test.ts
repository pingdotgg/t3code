import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, TaskId, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { taskMembershipDestinations } from "./taskActions.logic";
import { taskSettleBlocker, taskSnoozeBlocker } from "@t3tools/client-runtime/state/task-grouping";

const environmentId = EnvironmentId.make("local");
const otherEnvironmentId = EnvironmentId.make("remote");
function task(id: string, env = environmentId, archivedAt: string | null = null): EnvironmentTask {
  return {
    id: TaskId.make(id),
    environmentId: env,
    name: id,
    primaryProjectId: ProjectId.make("project"),
    description: null,
    archivedAt,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}
const options = { now: "2026-09-13T00:00:30.000Z" };
const member = {
  archivedAt: null,
  latestUserMessageAt: null,
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("task actions", () => {
  it("offers only other active tasks in the thread's physical environment", () => {
    const tasks = [
      task("current"),
      task("destination"),
      task("destination", otherEnvironmentId),
      task("archived", environmentId, "2026-09-13T00:00:00.000Z"),
    ];
    expect(
      taskMembershipDestinations(tasks, {
        environmentId,
        threadId: ThreadId.make("thread"),
        taskId: TaskId.make("current"),
      }),
    ).toEqual([tasks[1]]);
  });
  it("does not treat a generic input flag as proof that manual settlement is blocked", () => {
    const waiting = { ...member, hasPendingUserInput: true };
    expect(taskSettleBlocker([waiting], options)).toBeNull();
    expect(taskSnoozeBlocker([waiting], options)).toBe(waiting);
  });
  it("blocks a recent user message before turn adoption, then expires the queued guard", () => {
    const queued = { ...member, latestUserMessageAt: "2026-09-13T00:00:00.000Z" };
    expect(taskSettleBlocker([queued], options)).toBe(queued);
    expect(taskSnoozeBlocker([queued], options)).toBe(queued);
    const expired = { now: "2026-09-13T00:03:00.000Z" };
    expect(taskSettleBlocker([queued], expired)).toBeNull();
    expect(taskSnoozeBlocker([queued], expired)).toBeNull();
  });
  it("blocks pending approvals and a queued or running turn from shell evidence", () => {
    const pending = { ...member, hasPendingApprovals: true };
    const queued = {
      ...member,
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "running" as const,
        requestedAt: "2026-09-13T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    expect(taskSettleBlocker([pending], options)).toBe(pending);
    expect(taskSettleBlocker([queued], options)).toBe(queued);
    expect(taskSnoozeBlocker([queued], options)).toBe(queued);
    expect(
      taskSnoozeBlocker(
        [
          {
            ...queued,
            latestTurn: { ...queued.latestTurn, startedAt: queued.latestTurn.requestedAt },
          },
        ],
        options,
      ),
    ).toBeNull();
    expect(
      taskSettleBlocker([{ ...pending, archivedAt: "2026-09-13T00:00:00.000Z" }], options),
    ).toBeNull();
  });
});
