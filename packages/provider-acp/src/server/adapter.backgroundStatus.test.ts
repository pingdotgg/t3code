import { describe, expect, it } from "vite-plus/test";

import { applyTerminalProjectedToolStatus } from "./adapter.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

const backgroundShell: AcpToolCallState = {
  toolCallId: "call-3e89cd85-00b8-4678-acaf-d4d13afe3289-36",
  status: "inProgress",
  data: {
    rawOutput: {
      type: "BackgroundTaskStarted",
      task_id: "call-3e89cd85-00b8-4678-acaf-d4d13afe3289-36",
    },
  },
};

describe("applyTerminalProjectedToolStatus", () => {
  it("keeps a terminal projection when normalize left the shell running", () => {
    expect(applyTerminalProjectedToolStatus(backgroundShell, "failed").status).toBe("failed");
    expect(applyTerminalProjectedToolStatus(backgroundShell, "completed").status).toBe("completed");
    expect(applyTerminalProjectedToolStatus(backgroundShell, "failed").data).toBe(
      backgroundShell.data,
    );
  });

  it("leaves non-terminal projections to normalize", () => {
    expect(applyTerminalProjectedToolStatus(backgroundShell, undefined)).toBe(backgroundShell);
    expect(applyTerminalProjectedToolStatus(backgroundShell, "interrupted")).toBe(backgroundShell);
    expect(applyTerminalProjectedToolStatus(backgroundShell, "running")).toBe(backgroundShell);
  });

  it("keeps a finished shell finished when a later update is only running", () => {
    const finished: AcpToolCallState = { ...backgroundShell, status: "failed" };
    expect(applyTerminalProjectedToolStatus(backgroundShell, undefined, finished).status).toBe(
      "failed",
    );
    const completed: AcpToolCallState = { ...backgroundShell, status: "completed" };
    expect(applyTerminalProjectedToolStatus(backgroundShell, undefined, completed).status).toBe(
      "completed",
    );
    // An explicit projection still wins over the stored status.
    expect(applyTerminalProjectedToolStatus(backgroundShell, "completed", finished).status).toBe(
      "completed",
    );
    // A later update that is itself terminal is not rewritten back.
    const laterFailure: AcpToolCallState = { ...backgroundShell, status: "failed" };
    expect(applyTerminalProjectedToolStatus(laterFailure, undefined, completed)).toBe(laterFailure);
  });
});
