import { describe, expect, it } from "vite-plus/test";
import {
  derivePendingBackgroundWork,
  formatPendingBackgroundWorkLabel,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("derivePendingBackgroundWork", () => {
  it("returns empty while the latest run is not settled", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: null,
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("returns the provider-thread roster after settlement", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "Run Codex review", taskType: "local_bash" },
          ],
        },
      ],
      turnItems: [],
      activeProviderThreadId: "pt-1",
    });
    expect(tasks).toEqual([
      { taskId: "bg-1", description: "Run Codex review", taskType: "local_bash" },
    ]);
  });

  it("includes nonterminal turn items and excludes completed ones", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
        {
          id: "item-2" as never,
          type: "command_execution",
          status: "completed",
          title: "done",
          nativeItemRef: { nativeId: "cmd-2" },
          input: "echo done",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "cmd-1", description: "npm test", taskType: "command_execution" },
    ]);
  });

  it("dedupes roster entries against turn items by native task id", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "task-9", description: "Agent review" }],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Agent review",
          nativeItemRef: { nativeId: "task-9" },
          prompt: "review the plan",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "task-9", description: "Agent review" }]);
  });

  it("excludes Grok persistent monitors", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "dynamic_tool",
          status: "running",
          title: "monitor logs",
          nativeItemRef: { nativeId: "mon-1" },
          input: { persistent: true, command: "tail -f" },
        },
        {
          id: "item-2" as never,
          type: "dynamic_tool",
          status: "running",
          title: "finite monitor",
          nativeItemRef: { nativeId: "mon-2" },
          input: { persistent: false, command: "sleep 5" },
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "mon-2", description: "finite monitor", taskType: "dynamic_tool" },
    ]);
  });

  it("returns multiple tasks with stable ordering from insertion", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "first" },
            { taskId: "bg-2", description: "second" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "third",
          nativeItemRef: { nativeId: "cmd-3" },
          input: "third",
        },
      ],
    });
    expect(tasks.map((task) => task.taskId)).toEqual(["bg-1", "bg-2", "cmd-3"]);
  });
});

describe("formatPendingBackgroundWorkLabel", () => {
  it("formats single and multi-task labels", () => {
    expect(formatPendingBackgroundWorkLabel([])).toBeNull();
    expect(formatPendingBackgroundWorkLabel([{ taskId: "a" }])).toBe(
      "Waiting on a background task",
    );
    expect(
      formatPendingBackgroundWorkLabel([{ taskId: "a", description: "Run Codex review" }]),
    ).toBe("Waiting on background task: Run Codex review");
    expect(
      formatPendingBackgroundWorkLabel([
        { taskId: "a", description: "first" },
        { taskId: "b", description: "second" },
      ]),
    ).toBe("Waiting on 2 background tasks: first, …");
  });
});
