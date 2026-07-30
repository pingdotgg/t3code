import { describe, expect, it } from "vitest";

import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";

const snapshot: TerminalSessionSnapshot = {
  threadId: "thread-1",
  terminalId: "default",
  cwd: "/tmp",
  worktreePath: null,
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function eventBase() {
  return {
    threadId: "thread-1",
    terminalId: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("terminalRunningSubprocessFromEvent", () => {
  it("returns the subprocess flag for terminal activity events", () => {
    const active = terminalRunningSubprocessFromEvent({
      ...eventBase(),
      type: "activity",
      hasRunningSubprocess: true,
    });
    const idle = terminalRunningSubprocessFromEvent({
      ...eventBase(),
      type: "activity",
      hasRunningSubprocess: false,
    });

    expect(active).toBe(true);
    expect(idle).toBe(false);
  });

  it("clears running state when a terminal session starts/restarts/exits", () => {
    const events: TerminalEvent[] = [
      { ...eventBase(), type: "started", snapshot },
      { ...eventBase(), type: "restarted", snapshot },
      { ...eventBase(), type: "exited", exitCode: 0, exitSignal: null },
    ];

    for (const event of events) {
      expect(terminalRunningSubprocessFromEvent(event)).toBe(false);
    }
  });

  it("ignores non-activity terminal events", () => {
    expect(
      terminalRunningSubprocessFromEvent({
        ...eventBase(),
        type: "output",
        data: "hello",
      }),
    ).toBeNull();
    expect(
      terminalRunningSubprocessFromEvent({
        ...eventBase(),
        type: "error",
        message: "oops",
      }),
    ).toBeNull();
  });
});
