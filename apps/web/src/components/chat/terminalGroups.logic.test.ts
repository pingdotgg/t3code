import type { TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupThreadTerminals, terminalStatusLabel } from "./terminalGroups.logic";

const summary = (terminalId: string, patch: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 1,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: terminalId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("groupThreadTerminals", () => {
  it("groups busy and agent terminals as running and counts failures among settled ones", () => {
    const groups = groupThreadTerminals([
      summary("term-1"),
      summary("term-2", { hasRunningSubprocess: true }),
      summary("agent-1", { controller: "agent" }),
      summary("setup-1", { status: "exited", exitCode: 0 }),
      summary("agent-2", { status: "exited", exitCode: 2 }),
      summary("term-3", { status: "error" }),
    ]);
    expect(groups.running.map((entry) => entry.terminalId)).toEqual(["term-2", "agent-1"]);
    expect(groups.settled.map((entry) => entry.terminalId)).toEqual([
      "setup-1",
      "agent-2",
      "term-3",
    ]);
    expect(groups.failedCount).toBe(2);
  });

  it("labels each terminal's state", () => {
    expect(
      [
        summary("a", { hasRunningSubprocess: true }),
        summary("b", { controller: "agent" }),
        summary("c", { status: "exited", exitCode: 0 }),
        summary("d", { status: "exited", exitCode: 1 }),
      ].map((terminal) => terminalStatusLabel(terminal)),
    ).toEqual(["Running", "Idle", "Exited", "Exit 1"]);
  });
});
