import { describe, expect, it } from "vite-plus/test";

import { countRunningTerminalSessions, terminalRunningSessionLabel } from "./terminalRunningStatus";

describe("countRunningTerminalSessions", () => {
  it("counts only running terminals for the requested thread", () => {
    expect(
      countRunningTerminalSessions(
        [
          { threadId: "thread-1", hasRunningSubprocess: true },
          { threadId: "thread-1", hasRunningSubprocess: false },
          { threadId: "thread-2", hasRunningSubprocess: true },
        ],
        "thread-1",
      ),
    ).toBe(1);
  });
});

describe("terminalRunningSessionLabel", () => {
  it("hides idle terminal state", () => {
    expect(terminalRunningSessionLabel(0)).toBeNull();
  });

  it("describes one terminal with a running process", () => {
    expect(terminalRunningSessionLabel(1)).toBe("1 terminal has a running process");
  });

  it("describes multiple terminals with running processes", () => {
    expect(terminalRunningSessionLabel(2)).toBe("2 terminals have running processes");
  });
});
