import { describe, expect, it } from "vite-plus/test";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

describe("ThreadPlanProgress", () => {
  it("tracks the in-progress step and clears when the plan completes", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-1";
    progress.recordPlanProgress(threadId, [
      { step: "Audit failure paths", status: "completed" },
      { step: "Implement the fix", status: "inProgress" },
      { step: "Run targeted tests", status: "pending" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)).toEqual({
      step: "Implement the fix",
      completedSteps: 1,
      totalSteps: 3,
    });

    progress.recordPlanProgress(threadId, [
      { step: "Audit failure paths", status: "completed" },
      { step: "Implement the fix", status: "completed" },
      { step: "Run targeted tests", status: "completed" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)).toBeNull();
  });

  it("falls back to the first non-completed step when nothing is in progress", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-2";
    progress.recordPlanProgress(threadId, [
      { step: "First", status: "pending" },
      { step: "Second", status: "pending" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)?.step).toBe("First");
  });

  it("clearThreadPlanProgress removes the entry (turn settled / session died)", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-3";
    progress.recordPlanProgress(threadId, [{ step: "Only step", status: "inProgress" }]);
    progress.clearThreadPlanProgress(threadId);
    expect(progress.getThreadPlanProgress(threadId)).toBeNull();
  });
});
