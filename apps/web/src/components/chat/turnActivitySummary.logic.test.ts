import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import { m } from "../../i18n/messages";
import {
  sumTurnItemDiffStat,
  summarizeTurnActivity,
  turnActivityClauses,
} from "./turnActivitySummary.logic";

let nextId = 0;
const entry = (fields: Partial<WorkLogEntry>): WorkLogEntry => ({
  id: `entry-${(nextId += 1)}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  label: "Tool",
  tone: "tool",
  ...fields,
});

const read = () => entry({ itemType: "dynamic_tool", requestKind: "file-read", label: "Read" });
const command = (input: string) =>
  entry({ itemType: "command_execution", command: input, label: input });
const edit = (files: string[], additions?: number, deletions?: number) =>
  entry({
    itemType: "file_change",
    label: "Edit",
    changedFiles: files,
    structuredPayload: {
      type: "file_change",
      fileName: files[0] ?? "file.ts",
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
    } as NonNullable<WorkLogEntry["structuredPayload"]>,
  });

describe("summarizeTurnActivity", () => {
  it("counts tool calls by kind and edited files once each", () => {
    const summary = summarizeTurnActivity([
      read(),
      read(),
      edit(["a.ts"]),
      edit(["a.ts", "b.ts"]),
      command("vitest run"),
      { ...edit(["declined.ts"]), toolLifecycleStatus: "declined" },
      entry({ itemType: "reasoning", tone: "thinking", label: "Thought" }),
    ]);
    expect(summary).toEqual({
      read: 2,
      edit: 2,
      command: 1,
      codeSearch: 0,
      webSearch: 0,
      other: 0,
    });
    expect(turnActivityClauses(summary!, m)).toHaveLength(3);
  });

  it("gives up when the turn's work is only partly loaded", () => {
    const deferred = entry({
      itemType: "command_execution",
      command: "ls",
      projectedItem: {
        item: { deferredWork: { cursor: "c", itemCount: 4, lastOrdinal: 9 } },
      } as unknown as NonNullable<WorkLogEntry["projectedItem"]>,
    });
    expect(summarizeTurnActivity([read(), deferred])).toBeNull();
  });

  it("returns null for a turn without tool calls", () => {
    expect(
      summarizeTurnActivity([entry({ itemType: "reasoning", tone: "thinking", label: "T" })]),
    ).toBeNull();
  });
});

describe("sumTurnItemDiffStat", () => {
  it("sums the line counts file changes report", () => {
    expect(sumTurnItemDiffStat([edit(["a.ts"], 10, 2), edit(["b.ts"], 3), read()])).toEqual({
      additions: 13,
      deletions: 2,
    });
  });

  it("reports nothing when no change carries counts or all are zero", () => {
    expect(sumTurnItemDiffStat([edit(["a.ts"])])).toBeNull();
    expect(sumTurnItemDiffStat([edit(["a.ts"], 0, 0)])).toBeNull();
  });
});
