import { describe, expect, it } from "bun:test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveWorkLog,
  workLogIcon,
  workLogLabel,
  workLogPreview,
  workLogStatusKind,
  type WorkLogEntry,
} from "./worklog.ts";

let seq = 0;
function activity(partial: Partial<OrchestrationThreadActivity>): OrchestrationThreadActivity {
  seq += 1;
  return {
    id: `a${seq}`,
    tone: "tool",
    kind: "tool.updated",
    summary: "Tool",
    payload: {},
    turnId: null,
    sequence: seq,
    createdAt: `2026-06-19T00:00:0${seq}.000Z`,
    ...partial,
  } as OrchestrationThreadActivity;
}

describe("deriveWorkLog", () => {
  it("Given a command tool activity, then it yields one entry with the command preview", () => {
    const entries = deriveWorkLog([
      activity({
        summary: "Ran command",
        payload: { itemType: "command_execution", title: "Terminal", detail: "ls -la" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.itemType).toBe("command_execution");
    expect(entry.command).toBe("ls -la");
    expect(workLogIcon(entry)).toBe("$");
    expect(workLogPreview(entry)).toBe("ls -la");
  });

  it("Given lifecycle updates for one toolCallId, then they collapse into a single entry", () => {
    const entries = deriveWorkLog([
      activity({
        kind: "tool.updated",
        summary: "Edit",
        payload: { itemType: "file_change", data: { toolCallId: "t-1" }, status: "inProgress" },
      }),
      activity({
        kind: "tool.completed",
        summary: "Edit complete",
        payload: { itemType: "file_change", data: { toolCallId: "t-1" }, status: "completed" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toolLifecycleStatus).toBe("completed");
    expect(workLogStatusKind(entries[0]!)).toBe("success");
  });

  it("Given hidden lifecycle activities, then tool.started / context-window / checkpoint are dropped", () => {
    const entries = deriveWorkLog([
      activity({ kind: "tool.started", summary: "starting" }),
      activity({ kind: "context-window.updated", summary: "ctx" }),
      activity({ kind: "tool.completed", summary: "Checkpoint captured" }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("Given an ExitPlanMode tool activity, then it is treated as a plan boundary and hidden", () => {
    const entries = deriveWorkLog([
      activity({ kind: "tool.updated", summary: "Exit", payload: { detail: "ExitPlanMode: foo" } }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("Given a file-change activity with changed files, then the preview shows the first + count", () => {
    const entries = deriveWorkLog([
      activity({
        kind: "tool.completed",
        summary: "Edited files",
        payload: {
          itemType: "file_change",
          data: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
        },
      }),
    ]);
    const entry = entries[0]!;
    expect(entry.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(workLogPreview(entry)).toBe("src/a.ts +1 more");
    expect(workLogIcon(entry)).toBe("✎");
  });

  it("Given a thinking activity (task.progress), then its tone is thinking", () => {
    const entries = deriveWorkLog([
      activity({ kind: "task.progress", tone: "info", summary: "", payload: { summary: "Pondering" } }),
    ]);
    expect(entries[0]!.tone).toBe("thinking");
    expect(entries[0]!.label).toBe("Pondering");
    expect(workLogIcon(entries[0]!)).toBe("✱");
  });

  it("Given activities out of order, then they are sorted by sequence", () => {
    const a = activity({ sequence: 5, summary: "second", payload: { itemType: "web_search" } });
    const b = activity({ sequence: 2, summary: "first", payload: { itemType: "web_search" } });
    const entries = deriveWorkLog([a, b]);
    expect(entries.map((e) => e.label)).toEqual(["first", "second"]);
  });
});

describe("work-log view helpers", () => {
  it("normalizes a trailing 'complete' off the label", () => {
    const entry = { label: "Search complete", tone: "tool" } as WorkLogEntry;
    expect(workLogLabel(entry)).toBe("Search");
  });

  it("maps a failed status to a failure indicator", () => {
    const entry = { label: "x", tone: "tool", toolLifecycleStatus: "failed" } as WorkLogEntry;
    expect(workLogStatusKind(entry)).toBe("failure");
  });
});
