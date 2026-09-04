import { describe, expect, it } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalSelectionLineRange,
  writeTerminalOutputSegments,
} from "./ThreadTerminalDrawer";

describe("terminal selection actions", () => {
  it("clears a pending or currently owned menu when the selection disappears", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: true,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(true);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 4,
        currentRequestId: 4,
      }),
    ).toBe(true);
  });

  it("does not let an old selection popup cancel its replacement right-click menu", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
  });
});

describe("writeTerminalOutputSegments", () => {
  it("closes a streamed replay before writing live terminal output", () => {
    const actions: string[] = [];
    const result = writeTerminalOutputSegments({
      terminal: {
        beginStreamingReplay: (data) => actions.push(`begin:${data}`),
        appendStreamingReplay: (data) => actions.push(`append:${data}`),
        completeStreamingReplay: () => actions.push("complete"),
        write: (data) => actions.push(`write:${data}`),
      },
      segments: [
        { data: "history", delivery: "replay" },
        { data: "\u001b[5n", delivery: "live" },
      ],
      replayState: "waiting",
      onReplayComplete: () => actions.push("restore-scroll"),
    });

    expect(actions).toEqual(["begin:history", "complete", "restore-scroll", "write:\u001b[5n"]);
    expect(result).toEqual({ replayState: "idle", didWrite: true });
  });
});
