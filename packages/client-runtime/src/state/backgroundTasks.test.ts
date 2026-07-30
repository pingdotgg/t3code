import {
  EventId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBackgroundTasks } from "./backgroundTasks.ts";

const READY: Pick<OrchestrationSession, "status"> = { status: "ready" };
const RUNNING: Pick<OrchestrationSession, "status"> = { status: "running" };

let nextSequence = 0;

function activity(
  kind: string,
  payload: Record<string, unknown>,
  overrides: { readonly createdAt?: string; readonly sequence?: number; readonly id?: string } = {},
): OrchestrationThreadActivity {
  nextSequence += 1;
  const sequence = overrides.sequence ?? nextSequence;
  return {
    id: EventId.make(overrides.id ?? `activity-${sequence}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    sequence,
    // Monotonic with `sequence`, so replay order matches construction order.
    createdAt: overrides.createdAt ?? `2026-06-01T00:00:00.${String(sequence).padStart(3, "0")}Z`,
  };
}

const started = (taskId: string, payload: Record<string, unknown> = {}) =>
  activity("task.started", { taskId, ...payload });
const progress = (taskId: string, payload: Record<string, unknown> = {}) =>
  activity("task.progress", { taskId, ...payload });
const completed = (taskId: string, status = "completed") =>
  activity("task.completed", { taskId, status });

describe("deriveBackgroundTasks", () => {
  it("counts a child task started under a running parent turn", () => {
    const state = deriveBackgroundTasks([started("task-1", { detail: "Audit imports" })], RUNNING);

    expect(state.running).toHaveLength(1);
    expect(state.running[0]?.name).toBe("Audit imports");
    expect(state.startedAt).toBe(state.running[0]?.startedAt);
    expect(state.settled).toEqual([]);
  });

  it("keeps counting a child task after the parent turn completes", () => {
    // #4962: the parent session drops back to ready while the subagent runs.
    const state = deriveBackgroundTasks([started("task-1")], READY);

    expect(state.running).toHaveLength(1);
    expect(state.startedAt).not.toBeNull();
  });

  it("opens a task from progress alone and leaves its start unchanged", () => {
    const open = started("task-1");
    const state = deriveBackgroundTasks(
      [open, progress("task-1", { summary: "Reading files" })],
      READY,
    );

    expect(state.running).toHaveLength(1);
    expect(state.running[0]?.startedAt).toBe(open.createdAt);
    expect(state.running[0]?.latestProgress).toBe("Reading files");

    // Progress for a task we never saw start still counts: it implies running.
    const progressOnly = deriveBackgroundTasks([progress("task-2", { detail: "Grepping" })], READY);
    expect(progressOnly.running).toHaveLength(1);
    expect(progressOnly.running[0]?.latestProgress).toBe("Grepping");
  });

  it.each(["completed", "failed", "stopped"] as const)("clears the task on %s", (status) => {
    const state = deriveBackgroundTasks([started("task-1"), completed("task-1", status)], READY);

    expect(state.running).toEqual([]);
    expect(state.startedAt).toBeNull();
    expect(state.settled).toHaveLength(1);
    expect(state.settled[0]?.status).toBe(status);
  });

  it("clears only after the last of several tasks settles", () => {
    const first = started("task-1");
    const second = started("task-2");
    const withBoth = deriveBackgroundTasks([first, second], READY);
    expect(withBoth.running).toHaveLength(2);
    expect(withBoth.startedAt).toBe(first.createdAt);

    // The oldest OPEN task drives the aggregate elapsed label.
    const afterFirst = deriveBackgroundTasks([first, second, completed("task-1")], READY);
    expect(afterFirst.running).toHaveLength(1);
    expect(afterFirst.startedAt).toBe(second.createdAt);

    const afterBoth = deriveBackgroundTasks(
      [first, second, completed("task-1"), completed("task-2")],
      READY,
    );
    expect(afterBoth.running).toEqual([]);
    expect(afterBoth.startedAt).toBeNull();
    expect(afterBoth.settled).toHaveLength(2);
  });

  it("does not drift on duplicate or unknown lifecycle events", () => {
    const first = started("task-1");
    const duplicates = deriveBackgroundTasks(
      [first, started("task-1", { detail: "again" }), completed("task-2")],
      READY,
    );
    expect(duplicates.running).toHaveLength(1);
    expect(duplicates.running[0]?.startedAt).toBe(first.createdAt);
    // A terminal event for a task we never saw start is stale noise.
    expect(duplicates.settled).toEqual([]);

    const settledTwice = deriveBackgroundTasks(
      [first, completed("task-1"), completed("task-1", "failed")],
      READY,
    );
    expect(settledTwice.running).toEqual([]);
    expect(settledTwice.settled).toHaveLength(1);
    expect(settledTwice.settled[0]?.status).toBe("completed");

    // Settled wins: a late started/progress never reopens a finished task.
    const resurrected = deriveBackgroundTasks(
      [first, completed("task-1"), started("task-1"), progress("task-1", { detail: "late" })],
      READY,
    );
    expect(resurrected.running).toEqual([]);
    expect(resurrected.startedAt).toBeNull();
  });

  it.each([
    ["starting", 1],
    ["running", 1],
    ["ready", 1],
    ["idle", 0],
    ["stopped", 0],
    ["interrupted", 0],
    ["error", 0],
  ] as const)("gates outstanding tasks on a %s session", (status, expected) => {
    const state = deriveBackgroundTasks([started("task-1")], { status });
    expect(state.running).toHaveLength(expected);
  });

  it("reports nothing without a session", () => {
    // No session means no provider process, so no children either.
    const state = deriveBackgroundTasks([started("task-1")], null);
    expect(state).toEqual({ running: [], settled: [], startedAt: null });
  });

  it("names tasks by detail, then type, then a generic fallback", () => {
    const state = deriveBackgroundTasks(
      [
        started("task-detail", { detail: "Audit imports", taskType: "general" }),
        started("task-type", { taskType: "explore" }),
        started("task-bare"),
      ],
      READY,
    );

    const namesById = new Map(state.running.map((task) => [task.taskId, task.name]));
    expect(namesById.get("task-detail")).toBe("Audit imports");
    expect(namesById.get("task-type")).toBe("explore");
    expect(namesById.get("task-bare")).toBe("Subagent");
  });

  it("tracks the latest progress line per task", () => {
    const open = started("task-1");
    const first = progress("task-1", { summary: "Reading files" });
    const last = progress("task-1", { summary: "Writing the patch" });
    const state = deriveBackgroundTasks([open, first, last], READY);

    expect(state.running[0]?.latestProgress).toBe("Writing the patch");
    expect(state.running[0]?.latestProgressAt).toBe(last.createdAt);
  });

  it("orders settled tasks most recently settled first", () => {
    const state = deriveBackgroundTasks(
      [started("task-1"), started("task-2"), completed("task-1"), completed("task-2", "stopped")],
      READY,
    );

    expect(state.settled.map((task) => task.taskId)).toEqual(["task-2", "task-1"]);
  });

  it("ignores activities that are not task lifecycle events", () => {
    const state = deriveBackgroundTasks(
      [
        activity("assistant.message", { taskId: "task-1" }),
        activity("task.started", { taskId: "   " }),
        activity("task.started", {}),
      ],
      READY,
    );

    expect(state.running).toEqual([]);
  });

  it("replays out-of-order activities by sequence", () => {
    // Server-assigned sequence outranks createdAt, so a completion delivered
    // with an earlier wall clock still settles its task.
    const openEvent = activity("task.started", { taskId: "task-1" }, { sequence: 10 });
    const settleEvent = activity(
      "task.completed",
      { taskId: "task-1", status: "completed" },
      { sequence: 11, createdAt: "2020-01-01T00:00:00.000Z" },
    );

    expect(deriveBackgroundTasks([settleEvent, openEvent], READY).running).toEqual([]);
  });
});
