import { describe, expect, it } from "vite-plus/test";
import { RuntimeTaskId, TurnId } from "@t3tools/contracts";

import {
  buildGrokBackgroundTaskEvents,
  buildGrokTaskCompletedEvents,
  decideGrokTaskCompletedNotice,
  grokTaskCompletedNoticeId,
  rememberClosedTaskId,
  rememberPendingTaskCompletion,
  type GrokBackgroundTaskRecord,
} from "./XAiBackgroundTasks.ts";

const turnId = TurnId.make("turn-1");
const monitor = { type: "Monitor", taskId: "monitor-1", timeoutMs: 60_000 };
const shell = { type: "BackgroundTaskStarted", task_id: "shell-1", command: "sleep 40" };

function mapper() {
  const tasks = new Map<string, GrokBackgroundTaskRecord>();
  const update = (
    rawOutput: unknown,
    overrides: Partial<Parameters<typeof buildGrokBackgroundTaskEvents>[0]> = {},
  ) =>
    buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-1",
      rawInput: { description: "Watch" },
      rawOutput,
      toolCallStatus: "completed",
      turnId,
      ...overrides,
    });
  return { tasks, update };
}

describe("Grok background tasks", () => {
  it.each([
    [monitor, "monitor-1", "monitor", "Watch"],
    [shell, "shell-1", "shell", "sleep 40"],
  ] as const)("starts and deduplicates %j", (output, id, taskType, description) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([
      {
        type: "task.started",
        turnId,
        payload: { taskId: id, taskType, description, title: description, toolUseId: "call-1" },
      },
    ]);
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("accepts automatic backgrounding before the tool becomes terminal", () => {
    const { update } = mapper();
    expect(update(shell, { toolCallStatus: "inProgress" })[0]?.type).toBe("task.started");
    expect(update(monitor, { toolCallStatus: "inProgress" })).toEqual([]);
    expect(update(monitor, { toolCallStatus: "failed" })).toEqual([]);
  });

  it.each([
    ["running", null, "task.progress", undefined],
    ["pending", null, "task.progress", undefined],
    ["completed", 0, "task.completed", "completed"],
    ["success", 0, "task.completed", "completed"],
    ["succeeded", 0, "task.completed", "completed"],
    ["failed", 1, "task.completed", "failed"],
    ["error", 1, "task.completed", "failed"],
    ["stopped", 137, "task.completed", "stopped"],
    ["killed", 137, "task.completed", "stopped"],
    ["cancelled", 137, "task.completed", "stopped"],
    [undefined, 0, "task.completed", "completed"],
    [undefined, 1, "task.completed", "failed"],
  ])("maps poll status %s / exit %s", (status, exit_code, type, expectedStatus) => {
    const { tasks, update } = mapper();
    update(monitor);
    const events = update({
      type: "TaskOutput",
      Result: {
        task_id: "monitor-1",
        command: "[monitor:Watch]",
        status,
        exit_code,
        output: "\n result\nmore",
      },
    });
    expect(events).toEqual([
      {
        type,
        turnId,
        payload: {
          taskId: "monitor-1",
          taskType: "monitor",
          description: "Watch",
          title: "Watch",
          toolUseId: "call-1",
          summary: "result",
          ...(expectedStatus ? { status: expectedStatus } : {}),
        },
      },
    ]);
    expect(tasks.size).toBe(type === "task.progress" ? 1 : 0);
  });

  it.each([undefined, TurnId.make("turn-2")])(
    "does not attribute old tasks to a later turn: %s",
    (laterTurnId) => {
      const { tasks, update } = mapper();
      update(shell);
      const events = update(
        {
          type: "TaskOutput",
          Result: { task_id: "shell-1", command: "sleep 40", status: "completed" },
        },
        { turnId: laterTurnId },
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.turnId).toBeUndefined();
      expect(tasks.size).toBe(0);
    },
  );

  it("starts unknown poll tasks before progress or completion and ignores subagents", () => {
    const { tasks, update } = mapper();
    const events = update({
      type: "TaskOutput",
      MultiResult: {
        results: [
          { task_id: "shell-1", command: "sleep 40", status: "running" },
          { task_id: "monitor-1", command: "[monitor] Watch", status: "completed" },
          { task_id: "agent-1", command: "[subagent:executor] work", status: "running" },
        ],
      },
    });
    expect(events.map(({ type }) => type)).toEqual([
      "task.started",
      "task.progress",
      "task.started",
      "task.completed",
    ]);
    expect(events.map(({ payload }) => payload.taskType)).toEqual([
      "shell",
      "shell",
      "monitor",
      "monitor",
    ]);
    expect([...tasks.keys()]).toEqual(["shell-1"]);
    expect(events.map((event) => event.turnId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("retires only successfully killed tasks, including mixed results", () => {
    const { tasks, update } = mapper();
    update(shell);
    update(monitor);
    const result = { type: "KillTask", Result: { task_id: "shell-1", outcome: "killed" } };
    expect(update(result, { toolCallStatus: "failed" })).toEqual([]);
    expect(tasks.size).toBe(2);
    const events = update({
      type: "KillTask",
      MultiResult: {
        results: [
          result.Result,
          { task_id: "monitor-1", outcome: "error" },
          { task_id: "unknown", outcome: "killed" },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        turnId,
        payload: {
          taskId: "shell-1",
          taskType: "shell",
          description: "sleep 40",
          title: "sleep 40",
          toolUseId: "call-1",
          status: "stopped",
        },
      },
    ]);
    expect([...tasks.keys()]).toEqual(["monitor-1"]);
  });

  it.each([
    null,
    [],
    {},
    { type: "Text", text: "subagent_id: fake\ntype: executor\ndescription: fake" },
    { type: "Monitor", taskId: " " },
    { type: "BackgroundTaskStarted", task_id: "shell-1" },
    {
      type: "TaskOutput",
      MultiResult: {
        results: [null, {}, { task_id: "task", command: "sleep 40", exit_code: Infinity }],
      },
    },
  ])("ignores malformed or unrelated outputs: %j", (output) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(0);
  });
});

describe("Grok task_completed notices", () => {
  const monitorTaskId = "01a074d8-7c7f-7903-991f-1c9276e6e058";
  const monitorDescription = "Watch t3-plan draft until DONE/FAILED";

  function taskCompletedNotice(
    overrides: {
      task_id?: string;
      exit_code?: number | null;
      signal?: string | null;
      explicitly_killed?: boolean;
      completed?: boolean;
      output?: string;
      kind?: string;
      status?: string;
    } = {},
  ) {
    return {
      sessionId: "01a074d2-6fe5-79a2-8e2c-85686250e5ee",
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: monitorTaskId,
          command: "python3 /tmp/example/watch.py --unit t3-draft",
          display_command: `[monitor] ${monitorDescription}`,
          description: monitorDescription,
          kind: "monitor",
          exit_code: 0,
          signal: null,
          explicitly_killed: false,
          completed: true,
          is_backgrounded: true,
          output: "DONE t3-draft\n",
          start_time: 1_788_666_700.1,
          end_time: 1_788_666_972.0,
          ...overrides,
        },
        will_wake: true,
      },
    };
  }

  function seedMonitor(tasks: Map<string, GrokBackgroundTaskRecord>, taskTurnId = turnId) {
    buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-1",
      rawInput: { description: monitorDescription },
      rawOutput: { type: "Monitor", taskId: monitorTaskId, timeoutMs: 60_000 },
      toolCallStatus: "completed",
      turnId: taskTurnId,
    });
  }

  it("completes a known monitor from a task_completed notice", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice(),
      turnId: TurnId.make("turn-2"),
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: monitorTaskId,
          taskType: "monitor",
          description: monitorDescription,
          title: monitorDescription,
          toolUseId: "call-1",
          status: "completed",
          summary: "DONE t3-draft",
        },
      },
    ]);
    expect(tasks.size).toBe(0);
  });

  it("maps a non-zero exit code to failed", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice({ exit_code: 1, output: "FAILED pages\n" }),
    });
    const completed = events.find((event) => event.type === "task.completed");
    expect(completed?.payload.status).toBe("failed");
    expect(tasks.size).toBe(0);
  });

  it("completes a known monitor when completed is true but lifecycle status is absent", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    const closedTaskIds = new Set<string>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice({
        exit_code: null,
        signal: null,
        explicitly_killed: false,
      }),
      closedTaskIds,
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: monitorTaskId,
          taskType: "monitor",
          description: monitorDescription,
          title: monitorDescription,
          toolUseId: "call-1",
          status: "completed",
          summary: "DONE t3-draft",
        },
      },
    ]);
    expect(tasks.size).toBe(0);
    expect(closedTaskIds.has(monitorTaskId)).toBe(true);
  });

  it("maps explicitly killed bash tasks to stopped", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const events = buildGrokTaskCompletedEvents({
      tasks,
      notification: taskCompletedNotice({
        kind: "bash",
        exit_code: null,
        signal: "killed",
        explicitly_killed: true,
        output: "",
      }),
    });
    const completed = events.find((event) => event.type === "task.completed");
    expect(completed?.payload.status).toBe("stopped");
    expect(tasks.size).toBe(0);
  });

  it("ignores incomplete snapshots", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice({ completed: false }),
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("ignores unknown task ids without starting a task", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice({ task_id: "unknown-task" }),
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("ignores unrelated session/update kinds", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    expect(
      buildGrokTaskCompletedEvents({
        tasks,
        notification: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      }),
    ).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("does not complete an already-closed task twice", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    seedMonitor(tasks);
    const notice = taskCompletedNotice();
    const first = buildGrokTaskCompletedEvents({ tasks, notification: notice });
    const second = buildGrokTaskCompletedEvents({ tasks, notification: notice });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it("with closedTaskIds: notice closes monitor then late polls emit nothing", () => {
    const tasks = new Map<string, GrokBackgroundTaskRecord>();
    const closedTaskIds = new Set<string>();
    seedMonitor(tasks);
    const notice = taskCompletedNotice();
    const completed = buildGrokTaskCompletedEvents({
      tasks,
      notification: notice,
      closedTaskIds,
    });
    expect(completed).toHaveLength(1);
    expect(tasks.size).toBe(0);
    expect(closedTaskIds.has(monitorTaskId)).toBe(true);

    const terminalPoll = buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-2",
      rawInput: { description: monitorDescription },
      rawOutput: {
        type: "TaskOutput",
        Result: {
          task_id: monitorTaskId,
          command: `[monitor] ${monitorDescription}`,
          status: "completed",
          exit_code: 0,
          output: "late poll",
        },
      },
      toolCallStatus: "completed",
      closedTaskIds,
    });
    expect(terminalPoll).toEqual([]);

    const runningPoll = buildGrokBackgroundTaskEvents({
      tasks,
      toolCallId: "call-3",
      rawInput: { description: monitorDescription },
      rawOutput: {
        type: "TaskOutput",
        Result: {
          task_id: monitorTaskId,
          command: `[monitor] ${monitorDescription}`,
          status: "running",
        },
      },
      toolCallStatus: "completed",
      closedTaskIds,
    });
    expect(runningPoll).toEqual([]);

    const secondNotice = buildGrokTaskCompletedEvents({
      tasks,
      notification: notice,
      closedTaskIds,
    });
    expect(secondNotice).toEqual([]);
  });

  it.each([
    [TurnId.make("turn-2"), undefined],
    [turnId, turnId],
  ])(
    "attributes completion to the originating turn only when it matches: %s",
    (noticeTurnId, expectedTurnId) => {
      const tasks = new Map<string, GrokBackgroundTaskRecord>();
      seedMonitor(tasks);
      const events = buildGrokTaskCompletedEvents({
        tasks,
        notification: taskCompletedNotice(),
        turnId: noticeTurnId,
      });
      expect(events[0]?.turnId).toBe(expectedTurnId);
    },
  );
});

describe("grokTaskCompletedNoticeId", () => {
  const monitorTaskId = "01a074d8-7c7f-7903-991f-1c9276e6e058";

  function notice(
    overrides: {
      task_id?: string;
      completed?: boolean;
      kind?: string;
      sessionUpdate?: string;
    } = {},
  ) {
    const { sessionUpdate = "task_completed", ...snapshotOverrides } = overrides;
    return {
      sessionId: "session-1",
      update: {
        sessionUpdate,
        task_snapshot: {
          task_id: monitorTaskId,
          kind: "monitor",
          completed: true,
          ...snapshotOverrides,
        },
      },
    };
  }

  it("returns the id for a completed monitor notice", () => {
    expect(grokTaskCompletedNoticeId(notice())).toBe(monitorTaskId);
  });

  it.each([
    ["completed: false", { completed: false }],
    ["kind subagent", { kind: "subagent" }],
    ["non-task_completed sessionUpdate", { sessionUpdate: "agent_message_chunk" }],
    ["missing task_id", { task_id: " " }],
  ])("returns undefined for %s", (_label, overrides) => {
    expect(grokTaskCompletedNoticeId(notice(overrides))).toBeUndefined();
  });
});

describe("rememberClosedTaskId", () => {
  it("inserts a closed task id", () => {
    const closed = new Set<string>();
    rememberClosedTaskId(closed, "task-1");
    expect(closed.has("task-1")).toBe(true);
  });

  it("re-inserting an existing id moves it to newest", () => {
    const closed = new Set<string>();
    rememberClosedTaskId(closed, "task-1");
    rememberClosedTaskId(closed, "task-2");
    rememberClosedTaskId(closed, "task-1");
    expect([...closed]).toEqual(["task-2", "task-1"]);
  });

  it("evicts the oldest entry when exceeding the cap", () => {
    const closed = new Set<string>();
    for (let i = 0; i < 3; i++) {
      rememberClosedTaskId(closed, `task-${i}`, 2);
    }
    expect([...closed]).toEqual(["task-1", "task-2"]);
    expect(closed.has("task-0")).toBe(false);
  });

  it("uses a default cap of 500", () => {
    const closed = new Set<string>();
    for (let i = 0; i < 501; i++) {
      rememberClosedTaskId(closed, `task-${i}`);
    }
    expect(closed.size).toBe(500);
    expect(closed.has("task-0")).toBe(false);
    expect(closed.has("task-500")).toBe(true);
  });
});

describe("decideGrokTaskCompletedNotice", () => {
  const monitorTaskId = "01a074d8-7c7f-7903-991f-1c9276e6e058";
  const notice = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: monitorTaskId,
        kind: "monitor",
        completed: true,
      },
    },
  };
  const taskRecord: GrokBackgroundTaskRecord = {
    payload: {
      taskId: RuntimeTaskId.make(monitorTaskId),
      taskType: "monitor",
      description: "Watch",
      title: "Watch",
    },
    turnId: undefined,
  };

  it("ignores invalid notifications", () => {
    expect(
      decideGrokTaskCompletedNotice({
        notification: { update: { sessionUpdate: "agent_message_chunk" } },
        tasks: new Map(),
        publishedTaskIds: new Set(),
        closedTaskIds: new Set(),
      }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores closed task ids", () => {
    expect(
      decideGrokTaskCompletedNotice({
        notification: notice,
        tasks: new Map([[monitorTaskId, taskRecord]]),
        publishedTaskIds: new Set([monitorTaskId]),
        closedTaskIds: new Set([monitorTaskId]),
      }),
    ).toEqual({ action: "ignore" });
  });

  it("closes known and published tasks", () => {
    expect(
      decideGrokTaskCompletedNotice({
        notification: notice,
        tasks: new Map([[monitorTaskId, taskRecord]]),
        publishedTaskIds: new Set([monitorTaskId]),
        closedTaskIds: new Set(),
      }),
    ).toEqual({ action: "close", taskId: monitorTaskId });
  });

  it("parks known-but-unpublished tasks", () => {
    expect(
      decideGrokTaskCompletedNotice({
        notification: notice,
        tasks: new Map([[monitorTaskId, taskRecord]]),
        publishedTaskIds: new Set(),
        closedTaskIds: new Set(),
      }),
    ).toEqual({ action: "park", taskId: monitorTaskId });
  });

  it("parks unknown tasks", () => {
    expect(
      decideGrokTaskCompletedNotice({
        notification: notice,
        tasks: new Map(),
        publishedTaskIds: new Set(),
        closedTaskIds: new Set(),
      }),
    ).toEqual({ action: "park", taskId: monitorTaskId });
  });
});

describe("rememberPendingTaskCompletion", () => {
  const makeNotice = (id: string) => ({ update: { task_snapshot: { task_id: id } } });

  it("inserts a pending completion", () => {
    const pending = new Map<string, unknown>();
    rememberPendingTaskCompletion(pending, "task-1", makeNotice("task-1"));
    expect(pending.get("task-1")).toEqual(makeNotice("task-1"));
  });

  it("re-inserting an existing id moves it to newest", () => {
    const pending = new Map<string, unknown>();
    rememberPendingTaskCompletion(pending, "task-1", makeNotice("task-1"));
    rememberPendingTaskCompletion(pending, "task-2", makeNotice("task-2"));
    rememberPendingTaskCompletion(pending, "task-1", { refreshed: true });
    expect([...pending.keys()]).toEqual(["task-2", "task-1"]);
    expect(pending.get("task-1")).toEqual({ refreshed: true });
  });

  it("evicts the oldest entry when exceeding the cap", () => {
    const pending = new Map<string, unknown>();
    for (let i = 0; i < 3; i++) {
      rememberPendingTaskCompletion(pending, `task-${i}`, makeNotice(`task-${i}`), 2);
    }
    expect([...pending.keys()]).toEqual(["task-1", "task-2"]);
    expect(pending.has("task-0")).toBe(false);
  });

  it("uses a default cap of 100", () => {
    const pending = new Map<string, unknown>();
    for (let i = 0; i < 101; i++) {
      rememberPendingTaskCompletion(pending, `task-${i}`, makeNotice(`task-${i}`));
    }
    expect(pending.size).toBe(100);
    expect(pending.has("task-0")).toBe(false);
    expect(pending.has("task-100")).toBe(true);
  });
});
