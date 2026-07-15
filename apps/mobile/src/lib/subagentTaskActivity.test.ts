import { describe, expect, it } from "vite-plus/test";

import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveSubagentTasks,
  isSubagentTaskStalled,
  subagentTaskIdentityBadge,
  subagentTaskSubtitle,
  subagentTaskTitle,
  subagentTaskUsageSummary,
  SUBAGENT_TASK_STALLED_THRESHOLD_MS,
} from "./subagentTaskActivity";

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

describe("deriveSubagentTasks", () => {
  it("folds started/progress/completed into one row keyed by taskId", () => {
    const turnId = TurnId.make("turn-1");
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: EventId.make("evt-1"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        turnId,
        payload: {
          taskId: "task-1",
          description: "Explore the repo",
          subagentType: "Explore",
          model: "claude-sonnet-5",
        },
      }),
      makeActivity({
        id: EventId.make("evt-2"),
        kind: "task.progress",
        summary: "Task progress",
        createdAt: "2026-04-01T00:00:05.000Z",
        turnId,
        payload: {
          taskId: "task-1",
          description: "Explore the repo",
          lastToolName: "Grep",
          summary: "Searching for usages",
        },
      }),
      // Duplicate (same tool + text) — must be deduped, not appended twice.
      makeActivity({
        id: EventId.make("evt-3"),
        kind: "task.progress",
        summary: "Task progress",
        createdAt: "2026-04-01T00:00:06.000Z",
        turnId,
        payload: {
          taskId: "task-1",
          description: "Explore the repo",
          lastToolName: "Grep",
          summary: "Searching for usages",
        },
      }),
      makeActivity({
        id: EventId.make("evt-4"),
        kind: "task.completed",
        summary: "Task completed",
        createdAt: "2026-04-01T00:00:10.000Z",
        turnId,
        payload: {
          taskId: "task-1",
          status: "completed",
          summary: "Found 3 usages",
        },
      }),
    ];

    const tasks = deriveSubagentTasks(activities);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task).toBeDefined();
    if (!task) return;

    expect(task.taskId).toBe("task-1");
    expect(task.state).toBe("completed");
    expect(task.startedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(task.completedAt).toBe("2026-04-01T00:00:10.000Z");
    expect(task.completionSummary).toBe("Found 3 usages");
    // One progress entry (deduped) + the completion summary line.
    expect(task.progressLog).toHaveLength(2);
    expect(task.progressLog[0]).toMatchObject({ toolName: "Grep", text: "Searching for usages" });
    expect(task.progressLog[1]).toMatchObject({ toolName: null, text: "Found 3 usages" });

    expect(subagentTaskTitle(task)).toBe("Explore the repo");
    expect(subagentTaskIdentityBadge(task)).toBe("Explore · sonnet-5");
    expect(subagentTaskIdentityBadge(task, new Map([["claude-sonnet-5", "Sonnet 5"]]))).toBe(
      "Explore · Sonnet 5",
    );
    expect(subagentTaskSubtitle(task)).toBe("Found 3 usages");
  });

  it("shows the subagent's reasoning effort alongside its model", () => {
    const started = makeActivity({
      id: EventId.make("evt-effort-1"),
      kind: "task.started",
      summary: "Task started",
      createdAt: "2026-04-01T00:00:00.000Z",
      payload: {
        taskId: "task-effort",
        description: "Explore the repo",
        subagentType: "Explore",
        model: "claude-sonnet-5",
        effort: "xhigh",
      },
    });

    const task = deriveSubagentTasks([started])[0];
    expect(task).toBeDefined();
    if (!task) return;

    expect(task.effort).toBe("xhigh");
    expect(subagentTaskIdentityBadge(task, new Map([["claude-sonnet-5", "Sonnet 5"]]))).toBe(
      "Explore · Sonnet 5 · Extra High",
    );

    expect(
      subagentTaskIdentityBadge(
        { ...task, effort: "   " },
        new Map([["claude-sonnet-5", "Sonnet 5"]]),
      ),
    ).toBe("Explore · Sonnet 5");

    // Effort qualifies the model, so it stays hidden until the model is known.
    expect(subagentTaskIdentityBadge({ ...task, model: null })).toBe("Explore");
  });

  it("treats task.updated paused/killed status transitions like mac's state machine", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: EventId.make("evt-1"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-2" },
      }),
      makeActivity({
        id: EventId.make("evt-2"),
        kind: "task.updated",
        summary: "Task updated",
        createdAt: "2026-04-01T00:00:05.000Z",
        payload: { taskId: "task-2", status: "paused" },
      }),
    ];

    const [paused] = deriveSubagentTasks(activities);
    expect(paused?.state).toBe("paused");
    expect(paused?.completedAt).toBeNull();

    const killedActivities: OrchestrationThreadActivity[] = [
      ...activities,
      makeActivity({
        id: EventId.make("evt-3"),
        kind: "task.updated",
        summary: "Task updated",
        createdAt: "2026-04-01T00:00:10.000Z",
        payload: { taskId: "task-2", status: "killed", error: "stopped by user" },
      }),
    ];
    const [killed] = deriveSubagentTasks(killedActivities);
    expect(killed?.state).toBe("stopped");
    expect(killed?.completedAt).toBe("2026-04-01T00:00:10.000Z");
    expect(killed?.completionSummary).toBe("stopped by user");
  });

  it("caps the progress log and reports usage summaries", () => {
    const usage = { total_tokens: 4200, tool_uses: 3 };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: EventId.make("evt-1"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-3" },
      }),
      ...Array.from({ length: 210 }, (_, index) =>
        makeActivity({
          id: EventId.make(`evt-progress-${index}`),
          kind: "task.progress",
          summary: "Task progress",
          createdAt: `2026-04-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          payload: { taskId: "task-3", summary: `Step ${index}` },
        }),
      ),
      makeActivity({
        id: EventId.make("evt-completed"),
        kind: "task.completed",
        summary: "Task completed",
        createdAt: "2026-04-01T01:00:00.000Z",
        payload: { taskId: "task-3", status: "completed", usage },
      }),
    ];

    const [task] = deriveSubagentTasks(activities);
    expect(task?.progressLog.length).toBeLessThanOrEqual(200);
    expect(subagentTaskUsageSummary(task?.usage)).toBe("4200 tokens · 3 tools");
  });
});

describe("isSubagentTaskStalled", () => {
  it("flags running tasks with no activity past the threshold", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: EventId.make("evt-1"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-4" },
      }),
    ];
    const [task] = deriveSubagentTasks(activities);
    expect(task).toBeDefined();
    if (!task) return;

    const startedAtMs = Date.parse(task.startedAt);
    expect(isSubagentTaskStalled(task, startedAtMs + SUBAGENT_TASK_STALLED_THRESHOLD_MS - 1)).toBe(
      false,
    );
    expect(isSubagentTaskStalled(task, startedAtMs + SUBAGENT_TASK_STALLED_THRESHOLD_MS + 1)).toBe(
      true,
    );
  });

  it("treats a server-stalled signal as authoritative", () => {
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: EventId.make("evt-server-stalled"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-server-stalled" },
      }),
    ]);
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      isSubagentTaskStalled(task, Date.parse(task.startedAt) + 1_000, {
        stalled: true,
        lastActivityAt: new Date(task.startedAt),
      }),
    ).toBe(true);
  });

  it("lets a fresh active server signal suppress the local heuristic", () => {
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: EventId.make("evt-server-active"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-server-active" },
      }),
    ]);
    expect(task).toBeDefined();
    if (!task) return;

    const nowMs = Date.parse(task.startedAt) + SUBAGENT_TASK_STALLED_THRESHOLD_MS + 10_000;
    expect(
      isSubagentTaskStalled(task, nowMs, {
        stalled: false,
        lastActivityAt: new Date(nowMs - 1_000),
      }),
    ).toBe(false);
  });

  it("falls back to the local heuristic when an active server signal is stale", () => {
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: EventId.make("evt-server-stale"),
        kind: "task.started",
        summary: "Task started",
        createdAt: "2026-04-01T00:00:00.000Z",
        payload: { taskId: "task-server-stale" },
      }),
    ]);
    expect(task).toBeDefined();
    if (!task) return;

    const nowMs = Date.parse(task.startedAt) + SUBAGENT_TASK_STALLED_THRESHOLD_MS + 10_000;
    expect(
      isSubagentTaskStalled(task, nowMs, {
        stalled: false,
        lastActivityAt: new Date(nowMs - SUBAGENT_TASK_STALLED_THRESHOLD_MS - 1),
      }),
    ).toBe(true);
  });
});
