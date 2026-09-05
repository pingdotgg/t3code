import * as Schema from "effect/Schema";

// These experimental fields are absent from the pinned generated bindings.
// Keep the extension at the adapter boundary until the bindings are refreshed.
export const CodexMonitorOutput = Schema.Struct({ name: Schema.String, output: Schema.String });
export const CodexMonitorTurnInput = Schema.Struct({
  threadId: Schema.String,
  input: Schema.Array(Schema.Never),
  toolOutput: CodexMonitorOutput,
});
export const CodexBackgroundCleanResponse = Schema.Struct({});
export const CodexBackgroundTaskEvent = Schema.Struct({
  taskId: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
});

export function supportsCodexMonitoring(userAgent: string): boolean {
  const version = /\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(userAgent);
  if (!version) return false;
  const [, major, minor, patch] = version;
  return Number(major) > 0 || Number(minor) > 153 || (Number(minor) === 153 && Number(patch) >= 2);
}

interface Command {
  readonly id: string;
  readonly processId?: string | null;
  readonly source?: string;
  readonly command: string;
  readonly exitCode?: number | null;
}

interface BackgroundTask {
  readonly taskId: string;
  readonly description: string;
  readonly processId: string;
  monitor: boolean;
  remainder: string;
}

interface PendingWake {
  readonly taskId: string;
  readonly processId: string;
  readonly output: string;
}

const MAX_EVENT_LENGTH = 8_192;
const MAX_PENDING_EVENTS = 32;
const TRUNCATED = "\n[Further watcher output omitted]";

/** Tracks native command lifetimes separately from turns. Only explicitly
 * subscribed commands can enqueue wakes; output chunks are not event boundaries. */
export class CodexBackgroundTasks {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly pending = new Map<string, { processId: string; output: string }>();
  // The runtime delivers one wake at a time. Unsubscribe can invalidate it
  // while turn/start is pending, including after the process has exited.
  private inFlightWake: PendingWake | undefined;

  started(command: Command): typeof CodexBackgroundTaskEvent.Type | undefined {
    if (
      command.source !== "unifiedExecStartup" ||
      !command.processId ||
      this.tasks.has(command.id)
    ) {
      return;
    }
    const task = {
      taskId: command.id,
      processId: command.processId,
      description: command.command,
      monitor: false,
      remainder: "",
    };
    this.tasks.set(command.id, task);
    return { taskId: task.taskId, description: task.description, status: "running" };
  }

  subscribe(processId: string): boolean {
    const task = Array.from(this.tasks.values()).find((task) => task.processId === processId);
    if (!task) return false;
    task.monitor = true;
    return true;
  }

  unsubscribe(processId: string): void {
    if (this.inFlightWake?.processId === processId) this.inFlightWake = undefined;
    for (const [id, event] of this.pending)
      if (event.processId === processId) this.pending.delete(id);
    for (const task of this.tasks.values()) {
      if (task.processId !== processId) continue;
      task.monitor = false;
      task.remainder = "";
      this.pending.delete(task.taskId);
    }
  }

  output(itemId: string, delta: string): void {
    const task = this.tasks.get(itemId);
    if (!task?.monitor) return;
    // Bound both an unterminated line and a burst while the foreground is busy.
    let offset = 0;
    for (;;) {
      const newline = delta.indexOf("\n", offset);
      const end = newline === -1 ? delta.length : newline;
      task.remainder = (task.remainder + delta.slice(offset, end)).slice(0, MAX_EVENT_LENGTH + 1);
      if (newline === -1) break;
      this.enqueue(task, task.remainder.replace(/\r$/, ""));
      task.remainder = "";
      offset = end + 1;
    }
  }

  completed(command: Command): typeof CodexBackgroundTaskEvent.Type | undefined {
    // Interaction items (write_stdin) must not finish the owning startup item.
    const task = this.tasks.get(command.id);
    if (!task) return;
    this.tasks.delete(command.id);
    if (command.exitCode === -1) {
      this.pending.delete(command.id);
      if (this.inFlightWake?.taskId === command.id) this.inFlightWake = undefined;
    }
    if (task.monitor && command.exitCode !== -1) {
      this.enqueue(task, task.remainder);
      this.enqueue(task, `Watcher exited with code ${command.exitCode ?? "unknown"}.`);
    }
    return {
      taskId: task.taskId,
      description: task.description,
      status: command.exitCode === -1 ? "stopped" : command.exitCode === 0 ? "completed" : "failed",
    };
  }

  private enqueue(task: Pick<BackgroundTask, "taskId" | "processId">, line: string): void {
    if (!line.trim()) return;
    const previous = this.pending.get(task.taskId)?.output;
    if (previous === undefined && this.pending.size >= MAX_PENDING_EVENTS) return;
    if (previous?.endsWith(TRUNCATED)) return;
    const next = previous ? `${previous}\n${line}` : line;
    this.pending.set(task.taskId, {
      processId: task.processId,
      output: next.length > MAX_EVENT_LENGTH ? next.slice(0, MAX_EVENT_LENGTH) + TRUNCATED : next,
    });
  }

  takeWake(): PendingWake | undefined {
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [taskId, event] = entry;
    this.pending.delete(taskId);
    return (this.inFlightWake = { taskId, ...event });
  }

  restoreWake(wake: PendingWake): void {
    if (this.inFlightWake !== wake) return;
    this.inFlightWake = undefined;
    const later = this.pending.get(wake.taskId)?.output;
    // Reserve the failed event's place within the same bounded queue.
    if (!this.pending.has(wake.taskId) && this.pending.size >= MAX_PENDING_EVENTS) {
      const last = Array.from(this.pending.keys()).at(-1);
      if (last !== undefined) this.pending.delete(last);
    }
    this.pending.delete(wake.taskId);
    this.enqueue(wake, wake.output);
    if (later) this.enqueue(wake, later);
  }

  /** Disable wakes before interrupting the provider: termination output is
   * not a new event to act on. Keep liveness until actual completion arrives. */
  cancelWakes(): void {
    this.inFlightWake = undefined;
    this.pending.clear();
    for (const [id, task] of this.tasks)
      this.tasks.set(id, { ...task, monitor: false, remainder: "" });
  }

  stop(): ReadonlyArray<typeof CodexBackgroundTaskEvent.Type> {
    this.cancelWakes();
    const stopped = Array.from(this.tasks.values(), ({ taskId, description }) => ({
      taskId,
      description,
      status: "stopped" as const,
    }));
    this.tasks.clear();
    return stopped;
  }
}
