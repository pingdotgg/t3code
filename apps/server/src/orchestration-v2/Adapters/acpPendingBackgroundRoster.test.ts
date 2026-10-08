import { describe, expect, it } from "vite-plus/test";

import { acpPendingBackgroundRoster, acpSessionBackgroundTaskIds } from "./AcpAdapterV2.ts";

describe("acpPendingBackgroundRoster", () => {
  it("names only running tasks that have a detail, in task id order", () => {
    expect(
      acpPendingBackgroundRoster({
        runningTaskIds: new Set(["mon-1", "shell-1", "unnamed"]),
        details: new Map([
          ["mon-1", { kind: "monitor", description: "  Visible session monitor  " }],
          ["shell-1", { kind: "command", description: "Visible shell task" }],
        ]),
      }),
    ).toEqual([
      { taskId: "mon-1", kind: "monitor", description: "Visible session monitor" },
      { taskId: "shell-1", kind: "command", description: "Visible shell task" },
    ]);
  });

  it("keeps a session's tasks off another session's roster", () => {
    const runningTaskIds = new Set(["shell-a", "shell-b"]);
    const sessionByTaskId = new Map([
      ["shell-a", "session-a"],
      ["shell-b", "session-b"],
    ]);
    expect(
      acpPendingBackgroundRoster({
        runningTaskIds: acpSessionBackgroundTaskIds({
          runningTaskIds,
          sessionByTaskId,
          sessionId: "session-b",
        }),
        details: new Map([
          ["shell-a", { kind: "command", description: "Session A" }],
          ["shell-b", { kind: "command", description: "Session B" }],
        ]),
      }),
    ).toEqual([{ taskId: "shell-b", kind: "command", description: "Session B" }]);
  });

  it("omits a blank description", () => {
    expect(
      acpPendingBackgroundRoster({
        runningTaskIds: new Set(["shell-1"]),
        details: new Map([["shell-1", { kind: "command", description: "   " }]]),
      }),
    ).toEqual([{ taskId: "shell-1", kind: "command" }]);
  });
});
