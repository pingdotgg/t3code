import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { taskWorkbenchRef } from "@t3tools/client-runtime/state/task-workbench";

import {
  cacheTerminalGridSize,
  getCachedTerminalGridSize,
  resetTerminalUiStateCaches,
} from "./terminalUiState";

describe("terminalUiState", () => {
  beforeEach(() => {
    resetTerminalUiStateCaches();
  });

  it("uses the shared task owner and isolates the same task ID on another environment", () => {
    const owner = taskWorkbenchRef({
      environmentId: EnvironmentId.make("one"),
      taskId: TaskId.make("shared"),
    });
    const target = { ...owner, terminalId: "default" };
    cacheTerminalGridSize(target, { cols: 100, rows: 30 });
    expect(getCachedTerminalGridSize(target)).toEqual({ cols: 100, rows: 30 });
    expect(
      getCachedTerminalGridSize({ ...target, environmentId: EnvironmentId.make("two") }),
    ).toBeNull();
    expect(getCachedTerminalGridSize({ ...target, threadId: ThreadId.make("member") })).toBeNull();
  });

  it("stores terminal grid sizes per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "default",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    expect(getCachedTerminalGridSize(primaryTarget)).toBeNull();
    expect(
      cacheTerminalGridSize(primaryTarget, {
        cols: 107.9,
        rows: 33.2,
      }),
    ).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(primaryTarget)).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(otherTarget)).toBeNull();
  });
});
