import { describe, expect, it } from "vite-plus/test";

import {
  retainTerminalSnapshotHistory,
  skipTerminalSnapshotContinuation,
  terminalSequenceStateAfter,
} from "./terminal.ts";

describe("terminal snapshot replay", () => {
  const pendingDcs = "\u001bPz";
  const state = terminalSequenceStateAfter(0, pendingDcs);

  it.each([
    ["a tab stop before carriage return and tab", "\u0088\r\tready", "\u001bH\r\tready"],
    ["a byte after a string terminator", "\u1700ready", "\ufffdready"],
  ])("preserves %s after an omitted DCS", (_name, data, replay) => {
    expect(skipTerminalSnapshotContinuation(state, data)).toEqual({ state: 0, data: replay });
  });

  it("preserves a line break when the byte cut lands inside a completed DCS", () => {
    const history = pendingDcs + "z".repeat(50) + "\u0085ready";
    expect(retainTerminalSnapshotHistory(history, 10)).toEqual({ history: "\u001bEready" });
  });

  it.each([
    [8, "\u001bEready"],
    [10, "\u001bE\ufffdready"],
  ])("prioritizes the line break with a %i-byte history budget", (budget, replay) => {
    const history = pendingDcs + "z".repeat(50) + "\u2140ready";
    expect(retainTerminalSnapshotHistory(history, budget)).toEqual({ history: replay });
  });
});
