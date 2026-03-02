import { describe, expect, it } from "vitest";

import {
  createDefaultDraftThreadTerminalState,
  reduceDraftThreadTerminalState,
} from "./draftThreadTerminalState";

describe("draftThreadTerminalState", () => {
  it("creates a closed default terminal state", () => {
    expect(createDefaultDraftThreadTerminalState()).toEqual({
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
    const opened = reduceDraftThreadTerminalState(createDefaultDraftThreadTerminalState(), {
      type: "set-open",
      open: true,
    });
    const split = reduceDraftThreadTerminalState(opened, {
      type: "split",
      terminalId: "terminal-2",
    });

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
    const next = reduceDraftThreadTerminalState(createDefaultDraftThreadTerminalState(), {
      type: "new",
      terminalId: "terminal-2",
    });

    expect(next.terminalIds).toEqual(["default", "terminal-2"]);
    expect(next.activeTerminalId).toBe("terminal-2");
    expect(next.activeTerminalGroupId).toBe("group-terminal-2");
    expect(next.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("resets to default when closing the last terminal", () => {
    const closed = reduceDraftThreadTerminalState(createDefaultDraftThreadTerminalState(), {
      type: "close",
      terminalId: "default",
    });

    expect(closed).toEqual(createDefaultDraftThreadTerminalState());
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const splitOnce = reduceDraftThreadTerminalState(createDefaultDraftThreadTerminalState(), {
      type: "split",
      terminalId: "terminal-2",
    });
    const splitTwice = reduceDraftThreadTerminalState(splitOnce, {
      type: "split",
      terminalId: "terminal-3",
    });

    const closed = reduceDraftThreadTerminalState(splitTwice, {
      type: "close",
      terminalId: "terminal-3",
    });

    expect(closed.activeTerminalId).toBe("terminal-2");
    expect(closed.terminalIds).toEqual(["default", "terminal-2"]);
    expect(closed.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });
});
