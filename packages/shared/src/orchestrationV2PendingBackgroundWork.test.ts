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

  it("returns pending work when the latest run is waiting (post-success, pre-checkpoint)", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "waiting" },
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
      ],
    });
    expect(tasks).toEqual([
      { taskId: "cmd-1", description: "npm test", taskType: "command_execution" },
    ]);
  });

  it("still returns empty when the latest run is running even with background items", () => {
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
          type: "subagent",
          status: "running",
          title: "review",
          nativeItemRef: { nativeId: "sub-1" },
          prompt: "review",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("excludes rolled_back items when the latest run is waiting", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "waiting" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "cmd-new", description: "still pending", taskType: "command_execution" },
    ]);
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

  it("trims normalized background-work descriptions", () => {
    const base = {
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" as const },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            {
              taskId: "native-task",
              description: "  native background work  ",
            },
          ],
        },
      ],
    };
    expect(
      derivePendingBackgroundWork({
        ...base,
        turnItems: [
          {
            id: "item-command" as never,
            type: "command_execution",
            status: "running",
            title: "  npm test  ",
            nativeItemRef: null,
          },
          {
            id: "item-tool" as never,
            type: "dynamic_tool",
            status: "running",
            title: null,
            nativeItemRef: null,
            toolName: "  browser.search  ",
          } as never,
        ],
      }),
    ).toEqual([
      {
        taskId: "native-task",
        description: "native background work",
      },
      {
        taskId: "item-command",
        description: "npm test",
        taskType: "command_execution",
      },
      {
        taskId: "item-tool",
        description: "browser.search",
        taskType: "dynamic_tool",
      },
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

  it("excludes turn items owned by a rolled_back run", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("returns empty when the latest run is rolled_back even with a nonempty roster", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
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
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("excludes an older rolled_back nonterminal item when the latest run is completed", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "completed" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "cmd-new", description: "still pending", taskType: "command_execution" },
    ]);
  });

  it("does not reclassify an older active run as background work", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "provider-task" }],
        },
      ],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "running" },
        { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      ],
      turnItems: [
        {
          id: "item-active" as never,
          type: "command_execution",
          status: "running",
          title: "foreground work",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-active" },
          input: "vp check",
        },
      ],
    });

    expect(tasks).toEqual([]);
  });

  it("includes items with a null run id even when runs list has rolled_back rows", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-null-run" as never,
          type: "command_execution",
          status: "running",
          title: "orphan item",
          runId: null,
          nativeItemRef: { nativeId: "cmd-null" },
          input: "echo orphan",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "cmd-null", description: "orphan item", taskType: "command_execution" },
    ]);
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
