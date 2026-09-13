import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { wasBootstrapThreadDeleted, taskMembershipRejection } from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

it("reads membership reasons independently of bootstrap cleanup and ignores error prose", () => {
  for (const reason of ["missing", "archived", "unsupported"] as const) {
    for (const deleted of [true, false]) {
      const error = new OrchestrationDispatchCommandError({
        message: "The selected parent is unavailable.",
        taskMembershipRejection: reason,
        ...(deleted ? { bootstrapThreadDisposition: "deleted" as const } : {}),
      });
      expect(taskMembershipRejection(error)).toBe(reason);
      expect(wasBootstrapThreadDeleted(error)).toBe(deleted);
    }
  }
  expect(
    taskMembershipRejection(new OrchestrationDispatchCommandError({ message: "A task failed." })),
  ).toBeUndefined();
  expect(
    taskMembershipRejection({
      _tag: "OrchestrationDispatchCommandError",
      message: "Invalid reason",
      taskMembershipRejection: "other",
    }),
  ).toBeUndefined();
});
