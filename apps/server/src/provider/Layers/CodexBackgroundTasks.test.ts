import { describe, expect, it } from "vite-plus/test";
import { CodexBackgroundTasks, supportsCodexMonitoring } from "./CodexBackgroundTasks.ts";
import { make as makeLiveness } from "../../orchestration/ThreadBackgroundLiveness.ts";

const command = (id = "watch", monitor = true) => ({
  id,
  processId: `process-${id}`,
  source: "unifiedExecStartup",
  command: monitor ? "watch-ci" : "dev-server",
  commandActions: [{ command: monitor ? "watch-ci" : "dev-server" }],
  exitCode: 0,
});

describe("Codex background tasks", () => {
  it("keeps Monitoring until the last background shell exits", () => {
    const tasks = new CodexBackgroundTasks();
    const liveness = makeLiveness();
    for (const id of ["one", "two"]) {
      const task = tasks.started(command(id, false))!;
      liveness.recordTaskLiveness({
        threadId: "thread",
        ...task,
        taskType: "shell",
        kind: "started",
      });
    }
    expect(liveness.getThreadBackgroundLiveness("thread")).toBe("monitoring");
    const first = tasks.completed(command("one"))!;
    liveness.recordTaskLiveness({
      threadId: "thread",
      ...first,
      taskType: "shell",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBe("monitoring");
    const last = tasks.completed(command("two"))!;
    liveness.recordTaskLiveness({
      threadId: "thread",
      ...last,
      taskType: "shell",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("subscribes by native process ID and discards queued output on unsubscribe", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.output("watch", "before subscription\n");
    expect(tasks.takeWake()).toBeUndefined();
    expect(tasks.subscribe("unknown")).toBe(false);
    expect(tasks.subscribe("process-watch")).toBe(true);
    tasks.output("watch", "event\n");
    tasks.completed(command());
    tasks.unsubscribe("process-watch");
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("frames split lines and coalesces pending events without replaying drained output", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.output("watch", "CI pass");
    expect(tasks.takeWake()).toBeUndefined();
    tasks.output("watch", "ed\r\nDeploy ready\npartial");
    expect(tasks.takeWake()!).toEqual({
      taskId: "watch",
      processId: "process-watch",
      output: "CI passed\nDeploy ready",
    });
    expect(tasks.takeWake()).toBeUndefined();
    tasks.completed(command());
    expect(tasks.takeWake()!.output).toBe("partial\nWatcher exited with code 0.");
    expect(tasks.completed(command())).toBeUndefined();
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("requires an explicit subscription and ignores interaction items", () => {
    const tasks = new CodexBackgroundTasks();
    expect(tasks.started({ ...command(), source: "unifiedExecInteraction" })).toBeUndefined();
    expect(tasks.started({ ...command(), processId: null })).toBeUndefined();
    tasks.started(command());
    expect(tasks.started(command())).toBeUndefined();
    tasks.subscribe("process-watch");
    expect(
      tasks.completed({ ...command("interaction"), source: "unifiedExecInteraction" }),
    ).toBeUndefined();
    tasks.output("watch", "event\n");
    expect(tasks.takeWake()).toBeDefined();
    tasks.started({
      ...command("echo"),
      command: "echo watch-ci",
    });
    tasks.output("echo", "no wake\n");
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("suppresses queued and shutdown output after Stop, including late starts", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.output("watch", "pending\n");
    tasks.cancelWakes();
    tasks.started(command("late"));
    tasks.output("watch", "shutdown\n");
    tasks.output("late", "shutdown\n");
    tasks.completed({ ...command(), exitCode: -1 });
    expect(tasks.takeWake()).toBeUndefined();
    expect(tasks.stop()).toEqual([
      { taskId: "late", description: command("late").command, status: "stopped" },
    ]);
    expect(tasks.stop()).toEqual([]);
    tasks.output("late", "delayed\n");
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("bounds long lines and noisy output while waiting for an idle turn", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    for (let i = 0; i < 100; i++) tasks.output("watch", "x".repeat(1000));
    tasks.output("watch", "\nnext event\n");
    const output = tasks.takeWake()!.output;
    expect(output.length).toBeLessThan(8300);
    expect(output).toContain("omitted");
  });

  it("marks a single oversized line as truncated", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.output("watch", "x".repeat(9000) + "\n");
    expect(tasks.takeWake()?.output).toBe("x".repeat(8192) + "\n[Further watcher output omitted]");
  });

  it("restores a rejected event ahead of later output and still supports unsubscribe", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.output("watch", "first\n");
    const rejected = tasks.takeWake()!;
    tasks.output("watch", "second\n");
    tasks.restoreWake(rejected);
    expect(tasks.takeWake()?.output).toBe("first\nsecond");
    tasks.restoreWake(rejected);
    tasks.unsubscribe("process-watch");
    expect(tasks.takeWake()).toBeUndefined();
  });

  it.each([false, true])("unsubscribe invalidates an in-flight wake (exited: %s)", (exited) => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.output("watch", "old event\n");
    if (exited) tasks.completed(command());
    const wake = tasks.takeWake()!;
    tasks.unsubscribe("process-watch");
    tasks.subscribe("process-watch");
    tasks.restoreWake(wake);
    expect(tasks.takeWake()).toBeUndefined();
  });

  it("retains a rejected process-exit event when it has not been unsubscribed", () => {
    const tasks = new CodexBackgroundTasks();
    tasks.started(command());
    tasks.subscribe("process-watch");
    tasks.completed(command());
    const wake = tasks.takeWake()!;
    tasks.restoreWake(wake);
    expect(tasks.takeWake()?.output).toBe("Watcher exited with code 0.");
  });

  it.each([
    ["t3/0.146.0 (linux)", false],
    ["t3/0.153.1 (linux)", false],
    ["t3/0.153.2 (linux)", true],
    ["t3/0.154.0 (linux)", true],
    ["t3/1.0.0 (linux)", true],
    ["t3/0.153.2-alpha (linux)", false],
    ["unknown", false],
  ])("gates experimental wakes for %s", (version, supported) => {
    expect(supportsCodexMonitoring(version)).toBe(supported);
  });
});
