import { describe, expect, it } from "vitest";

import {
  closeThreadTerminal,
  createDefaultThreadTerminalState,
  newThreadTerminal,
  setThreadTerminalOpen,
  splitThreadTerminal,
} from "./threadTerminalState";

describe("threadTerminalState", () => {
  it("creates a closed default terminal state", () => {
    expect(createDefaultThreadTerminalState()).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
    });
  });

  it("opens and splits terminal tabs into the active group", () => {
    const opened = setThreadTerminalOpen(createDefaultThreadTerminalState(), true);
    const split = splitThreadTerminal(opened, "terminal-2");

    expect(split.terminalOpen).toBe(true);
    expect(split.terminalIds).toEqual(["default", "terminal-2"]);
    expect(split.activeTerminalId).toBe("terminal-2");
    expect(split.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2"],
      },
    ]);
  });

  it("creates new terminals in a new group", () => {
    const next = newThreadTerminal(createDefaultThreadTerminalState(), "terminal-2");

    expect(next.terminalIds).toEqual(["default", "terminal-2"]);
    expect(next.activeTerminalId).toBe("terminal-2");
    expect(next.activeTerminalGroupId).toBe("group-terminal-2");
    expect(next.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("resets to default when closing the last terminal", () => {
    const closed = closeThreadTerminal(createDefaultThreadTerminalState(), "default");

    expect(closed).toEqual(createDefaultThreadTerminalState());
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const splitOnce = splitThreadTerminal(createDefaultThreadTerminalState(), "terminal-2");
    const splitTwice = splitThreadTerminal(splitOnce, "terminal-3");

    const closed = closeThreadTerminal(splitTwice, "terminal-3");

    expect(closed.activeTerminalId).toBe("terminal-2");
    expect(closed.terminalIds).toEqual(["default", "terminal-2"]);
    expect(closed.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });
});
