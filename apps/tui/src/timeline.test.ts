import { describe, expect, it } from "bun:test";

import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "./connection.ts";
import {
  buildTimeline,
  changedFilesByMessage,
  diffStat,
  isWorking,
  revertableCheckpoints,
  withTurnSeparators,
  workingElapsedSeconds,
} from "./timeline.ts";

const message = (id: string, role: string, createdAt: string, text = "hi"): OrchestrationMessage =>
  ({ id, role, text, createdAt, streaming: false }) as unknown as OrchestrationMessage;

const toolActivity = (id: string, createdAt: string): OrchestrationThreadActivity =>
  ({
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { itemType: "command_execution", detail: "ls" },
    turnId: null,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    createdAt,
  }) as OrchestrationThreadActivity;

describe("buildTimeline", () => {
  it("Given messages and tool activities, then they interleave in chronological order", () => {
    const rows = buildTimeline(
      [
        message("m1", "user", "2026-06-19T00:00:00.000Z"),
        message("m2", "assistant", "2026-06-19T00:00:02.000Z"),
      ],
      [toolActivity("a1", "2026-06-19T00:00:01.000Z")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "tool", "message"]);
    expect(rows.map((r) => r.id)).toEqual(["m1", "a1", "m2"]);
  });

  it("Given a message and a tool at the same instant, then the message sorts first", () => {
    const rows = buildTimeline(
      [message("m1", "user", "2026-06-19T00:00:00.000Z")],
      [toolActivity("a1", "2026-06-19T00:00:00.000Z")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "tool"]);
  });
});

describe("withTurnSeparators", () => {
  const msgRow = (id: string, turnId: string | null) =>
    ({ kind: "message", id, message: { id, turnId } }) as never;
  const toolRow = (id: string, turnId: string | null) =>
    ({ kind: "tool", id, entry: { id, turnId } }) as never;

  it("Given rows across two turns, then a numbered separator precedes the second turn", () => {
    const entries = withTurnSeparators([
      msgRow("m1", "t1"),
      toolRow("a1", "t1"),
      msgRow("m2", "t2"),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["message", "tool", "separator", "message"]);
    const separator = entries.find((e) => e.kind === "separator");
    expect(separator).toMatchObject({ kind: "separator", turnNumber: 2 });
  });

  it("Given a single turn, then no separator is inserted", () => {
    const entries = withTurnSeparators([msgRow("m1", "t1"), toolRow("a1", "t1")]);
    expect(entries.some((e) => e.kind === "separator")).toBe(false);
  });

  it("Given a null turnId, then it does not start a new turn", () => {
    const entries = withTurnSeparators([msgRow("m0", null), msgRow("m1", "t1"), msgRow("m2", "t1")]);
    expect(entries.some((e) => e.kind === "separator")).toBe(false);
  });
});

describe("working indicator", () => {
  const thread = (over: Partial<OrchestrationThread>): OrchestrationThread =>
    ({ session: null, latestTurn: null, ...over }) as unknown as OrchestrationThread;

  it("Given a running session, then isWorking is true", () => {
    expect(isWorking(thread({ session: { status: "running" } as never }))).toBe(true);
  });

  it("Given a running latest turn, then isWorking is true", () => {
    expect(isWorking(thread({ latestTurn: { state: "running" } as never }))).toBe(true);
  });

  it("Given an idle session and completed turn, then isWorking is false", () => {
    expect(
      isWorking(
        thread({ session: { status: "idle" } as never, latestTurn: { state: "completed" } as never }),
      ),
    ).toBe(false);
  });

  it("computes whole elapsed seconds from the start time", () => {
    const started = "2026-06-19T00:00:00.000Z";
    const now = Date.parse("2026-06-19T00:00:12.500Z");
    expect(workingElapsedSeconds(started, now)).toBe(12);
  });

  it("returns null when there is no start time", () => {
    expect(workingElapsedSeconds(null, Date.now())).toBeNull();
  });
});

describe("changed files", () => {
  const checkpoint = (
    assistantMessageId: string | null,
    completedAt: string,
    files: Array<{ path: string; additions: number; deletions: number }>,
  ): OrchestrationCheckpointSummary =>
    ({
      assistantMessageId,
      completedAt,
      files: files.map((f) => ({ ...f, kind: "file" })),
    }) as unknown as OrchestrationCheckpointSummary;

  it("sums additions and deletions across files", () => {
    const stat = diffStat(checkpoint("m1", "t", [
      { path: "a", additions: 3, deletions: 1 },
      { path: "b", additions: 4, deletions: 2 },
    ]).files);
    expect(stat).toEqual({ additions: 7, deletions: 3 });
  });

  it("orders checkpoints newest-first for the revert picker", () => {
    const ordered = revertableCheckpoints([
      checkpoint("m1", "2026-06-19T00:00:01.000Z", []),
      checkpoint("m2", "2026-06-19T00:00:09.000Z", []),
      checkpoint("m3", "2026-06-19T00:00:05.000Z", []),
    ]);
    expect(ordered.map((c) => c.completedAt)).toEqual([
      "2026-06-19T00:00:09.000Z",
      "2026-06-19T00:00:05.000Z",
      "2026-06-19T00:00:01.000Z",
    ]);
  });

  it("maps the latest non-empty checkpoint to its assistant message", () => {
    const map = changedFilesByMessage([
      checkpoint("m1", "2026-06-19T00:00:00.000Z", [{ path: "a", additions: 1, deletions: 0 }]),
      checkpoint("m1", "2026-06-19T00:00:05.000Z", [{ path: "b", additions: 2, deletions: 0 }]),
      checkpoint(null, "2026-06-19T00:00:06.000Z", [{ path: "c", additions: 9, deletions: 9 }]),
      checkpoint("m2", "2026-06-19T00:00:07.000Z", []),
    ]);
    expect(map.get("m1")?.files[0]?.path).toBe("b");
    expect(map.has("m2")).toBe(false);
  });
});
