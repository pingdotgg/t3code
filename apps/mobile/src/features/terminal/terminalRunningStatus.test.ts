import { describe, expect, it } from "vite-plus/test";

import {
  countRunningTerminalSessions,
  terminalActionAccessibilityLabel,
  terminalRunningSessionLabel,
  threadRunningIndicatorPlacement,
  threadRunningAccessibilityLabel,
} from "./terminalRunningStatus";

describe("terminal running status", () => {
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

  it("describes singular, plural, and idle terminal state", () => {
    expect(terminalRunningSessionLabel(0)).toBeNull();
    expect(terminalRunningSessionLabel(1)).toBe("1 terminal has a running process");
    expect(terminalRunningSessionLabel(2)).toBe("2 terminals have running processes");
  });

  it("adds running terminal state to a row label without dropping other details", () => {
    expect(
      threadRunningAccessibilityLabel({
        title: "Fix mobile headers",
        detail: "Pull request 7793, open",
        hasRunningTerminal: true,
      }),
    ).toBe("Fix mobile headers, Pull request 7793, open, Terminal process running");
    expect(
      threadRunningAccessibilityLabel({
        title: "Idle thread",
        hasRunningTerminal: false,
      }),
    ).toBe("Idle thread");
  });

  it("places the indicator in every rendered row variant", () => {
    expect(threadRunningIndicatorPlacement({ variant: "v1", hasRunningTerminal: true })).toBe(
      "metadata",
    );
    expect(threadRunningIndicatorPlacement({ variant: "card", hasRunningTerminal: true })).toBe(
      "metadata",
    );
    expect(threadRunningIndicatorPlacement({ variant: "slim", hasRunningTerminal: true })).toBe(
      "trailing",
    );
    expect(
      threadRunningIndicatorPlacement({ variant: "slim", hasRunningTerminal: false }),
    ).toBeNull();
  });

  it("announces running state from terminal header actions", () => {
    expect(terminalActionAccessibilityLabel(0)).toBe("Open terminal");
    expect(terminalActionAccessibilityLabel(2)).toBe(
      "Open terminal, 2 terminals have running processes",
    );
  });
});
