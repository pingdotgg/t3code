import { describe, expect, it } from "bun:test";

import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "./connection.ts";
import {
  changedFilesByMessage,
  deriveTimelineEntries,
  diffStat,
  formatDuration,
  isWorking,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  revertableCheckpoints,
  workingElapsedSeconds,
} from "./timeline.ts";

const message = (
  id: string,
  role: string,
  createdAt: string,
  opts: { turnId?: string | null; text?: string; updatedAt?: string; streaming?: boolean } = {},
): OrchestrationMessage =>
  ({
    id,
    role,
    text: opts.text ?? "hi",
    createdAt,
    updatedAt: opts.updatedAt ?? createdAt,
    turnId: opts.turnId ?? null,
    streaming: opts.streaming ?? false,
  }) as unknown as OrchestrationMessage;

const toolActivity = (
  id: string,
  createdAt: string,
  turnId: string | null = null,
): OrchestrationThreadActivity =>
  ({
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { itemType: "command_execution", detail: "ls" },
    turnId,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    createdAt,
  }) as OrchestrationThreadActivity;

const latestTurn = (over: Record<string, unknown>): OrchestrationThread["latestTurn"] =>
  over as unknown as OrchestrationThread["latestTurn"];

describe("deriveTimelineEntries", () => {
  it("Given messages and tool activities, then they interleave in chronological order", () => {
    const rows = deriveTimelineEntries(
      [
        message("m1", "user", "2026-06-19T00:00:00.000Z"),
        message("m2", "assistant", "2026-06-19T00:00:02.000Z"),
      ],
      [toolActivity("a1", "2026-06-19T00:00:01.000Z")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "work", "message"]);
    expect(rows.map((r) => r.id)).toEqual(["m1", "a1", "m2"]);
  });

  it("Given a message and a tool at the same instant, then the message sorts first", () => {
    const rows = deriveTimelineEntries(
      [message("m1", "user", "2026-06-19T00:00:00.000Z")],
      [toolActivity("a1", "2026-06-19T00:00:00.000Z")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "work"]);
  });

  it("Given consecutive tool activities, then they group into one work row", () => {
    const rows = deriveTimelineEntries(
      [
        message("m1", "user", "2026-06-19T00:00:00.000Z"),
        message("m2", "assistant", "2026-06-19T00:00:09.000Z"),
      ],
      [
        toolActivity("a1", "2026-06-19T00:00:01.000Z"),
        toolActivity("a2", "2026-06-19T00:00:02.000Z"),
        toolActivity("a3", "2026-06-19T00:00:03.000Z"),
      ],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "work", "message"]);
    const work = rows.find((r) => r.kind === "work");
    expect(work).toBeDefined();
    if (work?.kind !== "work") throw new Error("expected work row");
    expect(work.groupedEntries.map((e) => e.id)).toEqual(["a1", "a2", "a3"]);
    // The row is keyed by its first entry, so it is stable as the group grows.
    expect(work.id).toBe("a1");
  });

  it("Given a message between tool runs, then it splits them into two work groups", () => {
    const rows = deriveTimelineEntries(
      [message("m1", "assistant", "2026-06-19T00:00:03.000Z")],
      [
        toolActivity("a1", "2026-06-19T00:00:01.000Z"),
        toolActivity("a2", "2026-06-19T00:00:02.000Z"),
        toolActivity("a3", "2026-06-19T00:00:04.000Z"),
      ],
    );
    expect(rows.map((r) => r.kind)).toEqual(["work", "message", "work"]);
  });
});

describe("turn folds", () => {
  it("folds a settled turn's work + commentary behind a 'Worked for' row, keeping the final message", () => {
    const rows = deriveTimelineEntries(
      [
        message("u1", "user", "2026-06-19T00:00:00.000Z", { turnId: "t1" }),
        message("c1", "assistant", "2026-06-19T00:00:04.000Z", { turnId: "t1", text: "thinking" }),
        message("m1", "assistant", "2026-06-19T00:00:05.000Z", {
          turnId: "t1",
          text: "done",
          updatedAt: "2026-06-19T00:00:05.000Z",
        }),
      ],
      [
        toolActivity("a1", "2026-06-19T00:00:01.000Z", "t1"),
        toolActivity("a2", "2026-06-19T00:00:03.000Z", "t1"),
      ],
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "turn-fold", "message"]);
    const fold = rows.find((r) => r.kind === "turn-fold");
    if (fold?.kind !== "turn-fold") throw new Error("expected a turn-fold row");
    expect(fold.turnId).toBe("t1");
    expect(fold.label).toBe("Worked for 5.0s");
    // The hidden rows: the grouped tool work, then the commentary message.
    expect(fold.hiddenRows.map((r) => r.kind)).toEqual(["work", "message"]);
    // The terminal assistant message is NOT hidden — it stays visible below.
    expect(rows.at(-1)).toMatchObject({ kind: "message", id: "m1" });
  });

  it("does not fold the latest unsettled (running) turn", () => {
    const rows = deriveTimelineEntries(
      [
        message("u1", "user", "2026-06-19T00:00:00.000Z", { turnId: "t1" }),
        message("c1", "assistant", "2026-06-19T00:00:02.000Z", { turnId: "t1" }),
      ],
      [toolActivity("a1", "2026-06-19T00:00:01.000Z", "t1")],
      latestTurn({ turnId: "t1", state: "running", startedAt: "2026-06-19T00:00:00.000Z", completedAt: null }),
    );
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(["message", "work", "message"]);
  });

  it("does not fold a turn that is only a terminal message (nothing to hide)", () => {
    const rows = deriveTimelineEntries(
      [
        message("u1", "user", "2026-06-19T00:00:00.000Z", { turnId: "t1" }),
        message("m1", "assistant", "2026-06-19T00:00:01.000Z", { turnId: "t1", text: "hi" }),
      ],
      [],
    );
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(["message", "message"]);
  });
});

describe("formatDuration", () => {
  it("renders sub-minute and minute buckets like the web", () => {
    expect(formatDuration(5_000)).toBe("5.0s");
    expect(formatDuration(22_000)).toBe("22s");
    expect(formatDuration(299_000)).toBe("4m 59s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});

describe("work-group collapsing", () => {
  it("keeps only the most recent entries visible by default", () => {
    expect(MAX_VISIBLE_WORK_LOG_ENTRIES).toBe(1);
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
