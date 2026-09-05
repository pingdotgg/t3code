import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import {
  buildGrokBackgroundTaskEvents,
  inferXAiToolMetaFromCompleted,
  parseBackgroundTaskStarted,
  parseKillTaskIds,
  parseMonitorStart,
  parseSpawnSubagentStart,
  parseTaskOutputResults,
  rememberXAiToolMeta,
  resolveCompletedXAiToolMeta,
  xaiToolMeta,
} from "./XAiBackgroundTasks.ts";

const spawnOutputText = [
  "Subagent started in background.",
  "subagent_id: 01a05f6b-5076-7303-b3a5-03d743b8de9b",
  "type: executor-cursor",
  "description: T3 Grok background task mapper",
].join("\n");

describe("XAiBackgroundTasks", () => {
  it("parses x.ai background task tool metadata and lifecycle payloads", () => {
    const spawnRawPayload = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "spawn_subagent",
            kind: "task",
            namespace: "grok_build",
            label: "Subagent",
            read_only: false,
          },
        },
        rawOutput: { type: "Text", text: spawnOutputText },
        status: "completed",
        toolCallId: "call-spawn-1",
      },
    };

    expect(xaiToolMeta(spawnRawPayload)).toEqual({
      name: "spawn_subagent",
      kind: "task",
    });
    expect(parseSpawnSubagentStart(spawnRawPayload.update.rawOutput)).toEqual({
      subagentId: "01a05f6b-5076-7303-b3a5-03d743b8de9b",
      subagentType: "executor-cursor",
      description: "T3 Grok background task mapper",
    });

    const monitorRawInput = {
      description: "Watch count-sheet Typst unit until done/fail/stall",
    };
    const monitorRawOutput = {
      type: "Monitor",
      taskId: "01a05f41-5107-7550-821e-79e8d1cd7687",
      timeoutMs: 36_000_000,
      persistent: false,
    };
    expect(parseMonitorStart(monitorRawInput, monitorRawOutput)).toEqual({
      taskId: "01a05f41-5107-7550-821e-79e8d1cd7687",
      description: "Watch count-sheet Typst unit until done/fail/stall",
      timeoutMs: 36_000_000,
    });

    expect(
      parseTaskOutputResults({
        type: "TaskOutput",
        Result: {
          task_id: "01a05f6b-5076-7303-b3a5-03d743b8de9b",
          command: "sleep 40; echo done-a",
          status: "running",
          exit_code: null,
          output: "still running",
        },
      }),
    ).toEqual([
      {
        taskId: "01a05f6b-5076-7303-b3a5-03d743b8de9b",
        command: "sleep 40; echo done-a",
        lifecycle: "running",
        output: "still running",
        summary: "still running",
      },
    ]);

    expect(parseKillTaskIds({ task_id: "call-87feed80-6aa1-47b5-87d5-199396c432ba-124" })).toEqual([
      "call-87feed80-6aa1-47b5-87d5-199396c432ba-124",
    ]);
    expect(
      parseKillTaskIds({
        variant: "KillTask",
        task_ids: ["task-a", "task-b"],
      }),
    ).toEqual(["task-a", "task-b"]);
  });

  it("does not infer spawn_subagent from output shape alone", () => {
    expect(
      inferXAiToolMetaFromCompleted({
        cache: new Map(),
        toolCallId: "call-spawn",
        rawInput: {},
        rawOutput: { type: "Text", text: spawnOutputText },
      }),
    ).toBeUndefined();
  });

  it("infers spawn_subagent only from rawInput or title", () => {
    expect(
      inferXAiToolMetaFromCompleted({
        cache: new Map(),
        toolCallId: "call-spawn",
        rawInput: { subagent_type: "executor-cursor" },
        rawOutput: { type: "Text", text: spawnOutputText },
      }),
    ).toEqual({ name: "spawn_subagent", kind: "task" });
    expect(
      inferXAiToolMetaFromCompleted({
        cache: new Map(),
        toolCallId: "call-spawn",
        rawInput: { variant: "Task" },
        rawOutput: { type: "Text", text: spawnOutputText },
      }),
    ).toEqual({ name: "spawn_subagent", kind: "task" });
    expect(
      inferXAiToolMetaFromCompleted({
        cache: new Map(),
        toolCallId: "call-spawn",
        rawInput: {},
        rawOutput: { type: "Text", text: spawnOutputText },
        title: "spawn_subagent",
      }),
    ).toEqual({ name: "spawn_subagent", kind: "task" });
  });

  it("does not map spawn_subagent completions to task events", () => {
    const started = buildGrokBackgroundTaskEvents({
      tasks: new Map(),
      toolMeta: { name: "spawn_subagent", kind: "task" },
      toolCallId: "call-spawn-1",
      rawInput: { variant: "Task", subagent_type: "executor-cursor" },
      rawOutput: { type: "Text", text: spawnOutputText },
    });
    expect(started).toEqual([]);
  });

  it("maps monitor completion to task.started", () => {
    const tasks = new Map();
    const started = buildGrokBackgroundTaskEvents({
      tasks,
      toolMeta: { name: "monitor", kind: "task" },
      toolCallId: "call-monitor-1",
      rawInput: { description: "Watch the unit" },
      rawOutput: {
        type: "Monitor",
        taskId: "monitor-1",
        timeoutMs: 1_000,
      },
    });
    expect(started).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: "monitor-1",
          description: "Watch the unit",
          title: "Watch the unit",
          taskType: "monitor",
          toolUseId: "call-monitor-1",
        },
      },
    ]);
    expect(tasks.get("monitor-1")?.taskType).toBe("monitor");
  });

  it("emits task.started then task.progress for an orphan running poll", () => {
    const tasks = new Map();
    const events = buildGrokBackgroundTaskEvents({
      tasks,
      toolMeta: { name: "get_command_or_subagent_output", kind: "background_task_action" },
      toolCallId: "call-poll-running",
      rawInput: { variant: "TaskOutput", task_ids: ["shell-1"] },
      rawOutput: {
        type: "TaskOutput",
        Result: {
          task_id: "shell-1",
          command: "sleep 40; echo done-a",
          status: "running",
          exit_code: null,
          output: "still going",
        },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.progress"]);
    expect(events[0]?.payload.taskType).toBe("shell");
    expect(events[0]?.payload.description).toBe("sleep 40; echo done-a");
    expect(tasks.has("shell-1")).toBe(true);
  });

  it("emits task.started then task.completed for an orphan terminal poll", () => {
    const tasks = new Map();
    const events = buildGrokBackgroundTaskEvents({
      tasks,
      toolMeta: { name: "get_command_or_subagent_output", kind: "background_task_action" },
      toolCallId: "call-poll-done",
      rawInput: { variant: "TaskOutput", task_ids: ["shell-1"] },
      rawOutput: {
        type: "TaskOutput",
        Result: {
          task_id: "shell-1",
          command: "sleep 40; echo done-a",
          status: "completed",
          exit_code: 0,
          output: "done-a",
        },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(events[1]?.type === "task.completed" && events[1].payload.status).toBe("completed");
    expect(tasks.has("shell-1")).toBe(false);
  });

  it("preserves stopped/killed/cancelled as task.completed status stopped", () => {
    for (const status of ["stopped", "killed", "cancelled"] as const) {
      const tasks = new Map();
      tasks.set("shell-1", { taskType: "shell", description: "sleep 40" });
      const events = buildGrokBackgroundTaskEvents({
        tasks,
        toolMeta: { name: "get_command_or_subagent_output", kind: "background_task_action" },
        toolCallId: "call-poll-stopped",
        rawInput: { variant: "TaskOutput", task_ids: ["shell-1"] },
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: "shell-1",
            command: "sleep 40",
            status,
            exit_code: 137,
            output: "killed",
          },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task.completed");
      if (events[0]?.type === "task.completed") {
        expect(events[0].payload.status).toBe("stopped");
      }
      expect(tasks.has("shell-1")).toBe(false);
    }
  });

  it("ignores a failed kill call and keeps the task live", () => {
    const tasks = new Map([
      ["shell-1", { taskType: "shell", description: "sleep 40", toolUseId: "call-1" }],
    ]);
    const events = buildGrokBackgroundTaskEvents({
      tasks,
      toolMeta: { name: "kill_command_or_subagent", kind: "kill_task_action" },
      toolCallId: "call-kill-failed",
      rawInput: { task_ids: ["shell-1"] },
      rawOutput: { error: "no such task" },
      toolCallStatus: "failed",
    });
    expect(events).toEqual([]);
    expect(tasks.has("shell-1")).toBe(true);
  });

  it("evicts the task map on kill completions", () => {
    const tasks = new Map();
    tasks.set("shell-1", { taskType: "shell", description: "sleep 40" });
    const events = buildGrokBackgroundTaskEvents({
      tasks,
      toolMeta: { name: "kill_command_or_subagent", kind: "kill_task_action" },
      toolCallId: "call-kill",
      rawInput: { task_ids: ["shell-1"] },
      rawOutput: {},
      toolCallStatus: "completed",
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: "shell-1",
          description: "sleep 40",
          title: "sleep 40",
          taskType: "shell",
          status: "stopped",
        },
      },
    ]);
    expect(tasks.size).toBe(0);
  });

  it("maps BackgroundTaskStarted to task.started shell without tool meta", () => {
    const tasks = new Map();
    const toolCallId = "call-fb9d-26";
    const events = buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId,
      rawInput: { command: "sleep 40; echo done-a" },
      rawOutput: {
        type: "BackgroundTaskStarted",
        task_id: toolCallId,
        task_type: "bash",
        status: "running",
        command: "sleep 40; echo done-a",
      },
    });
    expect(events).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: toolCallId,
          description: "sleep 40; echo done-a",
          title: "sleep 40; echo done-a",
          taskType: "shell",
          toolUseId: toolCallId,
        },
      },
    ]);
    expect(
      parseBackgroundTaskStarted({ type: "BackgroundTaskStarted", task_id: toolCallId }),
    ).toBeUndefined();
  });

  it("infers monitor and poll tools from distinctive completed shapes", () => {
    const empty = new Map();
    expect(
      inferXAiToolMetaFromCompleted({
        cache: empty,
        toolCallId: "call-monitor",
        rawInput: { description: "Watch count-sheet Typst unit until done/fail/stall" },
        rawOutput: {
          type: "Monitor",
          taskId: "01a05f41-5107-7550-821e-79e8d1cd7687",
          timeoutMs: 36_000_000,
        },
      }),
    ).toEqual({ name: "monitor", kind: "task" });

    expect(
      inferXAiToolMetaFromCompleted({
        cache: empty,
        toolCallId: "call-poll",
        rawInput: { variant: "TaskOutput", task_ids: ["shell-1"] },
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: "shell-1",
            command: "sleep 40",
            status: "running",
            exit_code: null,
            output: "still",
          },
        },
      }),
    ).toEqual({ name: "get_command_or_subagent_output", kind: "background_task_action" });

    expect(
      inferXAiToolMetaFromCompleted({
        cache: empty,
        toolCallId: "call-kill",
        rawInput: { task_id: "task-a" },
        rawOutput: undefined,
        title: "kill_command_or_subagent",
      }),
    ).toEqual({ name: "kill_command_or_subagent", kind: "kill_task_action" });
  });

  it("resolves monitor meta from cache when completed drops _meta", () => {
    const cache = new Map();
    const toolCallId = "call-monitor-1";
    rememberXAiToolMeta(cache, toolCallId, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        _meta: { "x.ai/tool": { name: "monitor", kind: "task" } },
        toolCallId,
      },
    });
    const toolMeta = resolveCompletedXAiToolMeta({
      cache,
      toolCallId,
      rawPayload: {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call_update", status: "completed", toolCallId },
      },
      rawInput: { description: "Watch" },
      rawOutput: { type: "Monitor", taskId: "monitor-1", timeoutMs: 1 },
    });
    expect(toolMeta).toEqual({ name: "monitor", kind: "task" });
  });
});
