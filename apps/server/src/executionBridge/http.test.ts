import { describe, expect, it } from "vitest";

import { shouldForwardLifecycleCheckpoint } from "./http.ts";
import type { TrackedExecutionRun } from "./runStart.ts";

function makeTrackedRun(overrides?: Partial<TrackedExecutionRun>): TrackedExecutionRun {
  return {
    kind: "execution",
    controlThreadId: "control-thread-1",
    executionRunId: "execution-run-1",
    taskId: null,
    workSessionId: null,
    threadId: "thread-1" as TrackedExecutionRun["threadId"],
    startedEventId: null,
    completedEventId: null,
    failedEventId: null,
    interruptedEventId: null,
    lastTurnId: null,
    ...overrides,
  };
}

describe("shouldForwardLifecycleCheckpoint", () => {
  it("does not forward completion before the first turn has started", () => {
    expect(
      shouldForwardLifecycleCheckpoint({
        type: "completed",
        trackedRun: makeTrackedRun(),
      }),
    ).toBe(false);
  });

  it("forwards completion after a started turn has been recorded", () => {
    expect(
      shouldForwardLifecycleCheckpoint({
        type: "completed",
        trackedRun: makeTrackedRun({
          startedEventId: "evt-started",
          lastTurnId: "turn-1" as TrackedExecutionRun["lastTurnId"],
        }),
      }),
    ).toBe(true);
  });
});
