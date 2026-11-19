import * as NodeEvents from "node:events";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComputerHostChild,
  type ComputerHostTask,
  startComputerHostProcess,
} from "./ComputerHostProcess.ts";

type SentFrame = {
  readonly id: string;
  readonly kind: string;
  readonly task?: { readonly goal: string; readonly text: string | null };
  readonly limits?: { readonly maxSteps: number; readonly timeoutMs: number };
  readonly taskId?: string;
};

function fakeChild() {
  return Object.assign(new NodeEvents.EventEmitter(), {
    send: vi.fn(),
    kill: vi.fn(),
  });
}

type FakeChild = ReturnType<typeof fakeChild>;

const sent = (child: FakeChild): ReadonlyArray<SentFrame> =>
  child.send.mock.calls.map(([line]) => JSON.parse(String(line)) as SentFrame);

const deliver = (child: FakeChild, frame: Record<string, unknown>) =>
  child.emit("message", `${JSON.stringify(frame)}\n`);

const limits = { maxSteps: 15 } as ComputerHostTask["limits"];

function task(overrides: Partial<ComputerHostTask> = {}): ComputerHostTask {
  return {
    environmentId: "environment-a",
    requestId: "request-1",
    taskId: "task-1",
    goal: "search my notes for groceries",
    text: "groceries",
    limits,
    ask: {
      authorize: vi.fn().mockResolvedValue({ ok: true, grant: "allow" }),
      decide: vi.fn().mockResolvedValue({}),
      event: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the computer helper process", () => {
  it("forks the app's own binary in Node mode and runs one task at a time", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child as unknown as ComputerHostChild);
    const process = startComputerHostProcess({ workerPath: "/app/computer.cjs", fork });

    const first = task();
    const started = process.start(first);
    expect(fork).toHaveBeenCalledWith("/app/computer.cjs");
    expect(sent(child)).toEqual([
      {
        id: "task-1",
        kind: "start",
        task: { goal: "search my notes for groceries", text: "groceries" },
        limits: { maxSteps: 15, timeoutMs: undefined },
      },
    ]);
    // A start racing this one is busy before the helper has answered the first.
    expect(
      await process.start(
        task({ environmentId: "environment-b", requestId: "request-0", taskId: "task-0" }),
      ),
    ).toEqual({ ok: false, busy: true });
    deliver(child, { id: "task-1", kind: "started", taskId: "task-1" });

    expect(await started).toEqual({ ok: true });
    expect(process.task).toEqual({ environmentId: "environment-a", taskId: "task-1" });

    // A task from another environment waits for this one, and nothing reaches the helper.
    const second = task({
      environmentId: "environment-b",
      requestId: "request-2",
      taskId: "task-2",
    });
    expect(await process.start(second)).toEqual({ ok: false, busy: true });
    expect(sent(child)).toHaveLength(1);

    deliver(child, {
      id: "task-1",
      kind: "finished",
      taskId: "task-1",
      outcome: { status: "done", reason: "", steps: ["worked"], surface: "Notes" },
    });
    await vi.waitFor(() => expect(process.task).toBeNull());
    expect(first.ask.event).toHaveBeenCalledWith({
      type: "finished",
      status: "done",
      reason: "",
      steps: ["worked"],
      surface: "Notes",
    });

    // The same child serves the next task; a second task does not fork again.
    const third = process.start(task({ requestId: "request-3", taskId: "task-3" }));
    expect(fork).toHaveBeenCalledTimes(1);
    expect(sent(child).at(-1)).toMatchObject({ id: "task-3", kind: "start" });
    deliver(child, { id: "task-3", kind: "started", taskId: "task-3" });
    expect(await third).toEqual({ ok: true });
    process.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("gives up on a helper that stops answering and replaces it", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const fork = vi.fn(() => child as unknown as ComputerHostChild);
    const process = startComputerHostProcess({
      workerPath: "/app/computer.cjs",
      fork,
      replyTimeoutMs: 50,
    });

    const started = process.start(task());
    await vi.advanceTimersByTimeAsync(50);

    expect(await started).toMatchObject({ ok: false, busy: false });
    expect(child.kill).toHaveBeenCalled();
    expect(process.alive).toBe(false);

    const replacement = fakeChild();
    fork.mockReturnValue(replacement as unknown as ComputerHostChild);
    const retried = process.start(task({ requestId: "request-2", taskId: "task-2" }));
    expect(fork).toHaveBeenCalledTimes(2);
    expect(sent(replacement)).toMatchObject([{ id: "task-2", kind: "start" }]);
    deliver(replacement, { id: "task-2", kind: "started", taskId: "task-2" });
    expect(await retried).toEqual({ ok: true });
  });

  it("ends a running task as failed when its helper crashes", async () => {
    const child = fakeChild();
    const onExit = vi.fn();
    const process = startComputerHostProcess({
      workerPath: "/app/computer.cjs",
      fork: (() => child as unknown as ComputerHostChild) as never,
      onExit,
    });
    const running = task();
    const started = process.start(running);
    deliver(child, { id: "task-1", kind: "started", taskId: "task-1" });
    await started;

    child.emit("exit", 1, null);

    await vi.waitFor(() =>
      expect(running.ask.event).toHaveBeenCalledWith({
        type: "finished",
        status: "failed",
        reason: "The computer helper stopped.",
        steps: [],
        surface: null,
      }),
    );
    expect(onExit).toHaveBeenCalledWith("The computer helper stopped.");
    expect(process.alive).toBe(false);
    expect(process.task).toBeNull();
  });

  it("asks the environment for each step's grant and answers the helper with it", async () => {
    const child = fakeChild();
    const process = startComputerHostProcess({
      workerPath: "/app/computer.cjs",
      fork: (() => child as unknown as ComputerHostChild) as never,
    });
    const running = task();
    const started = process.start(running);
    deliver(child, { id: "task-1", kind: "started", taskId: "task-1" });
    await started;

    deliver(child, {
      id: "grant_1",
      kind: "authorize",
      taskId: "task-1",
      request: {
        step: 1,
        observation: { app: "Safari", title: "Example" },
        // The helper's own words for a press carrying its field: the contract flattens it.
        action: { kind: "press", key: "enter", field: { role: "textbox", label: "Search" } },
      },
    });

    await vi.waitFor(() =>
      expect(running.ask.authorize).toHaveBeenCalledWith({
        step: 1,
        observation: { app: "Safari", title: "Example" },
        action: { kind: "press", key: "enter", fieldRole: "textbox", fieldLabel: "Search" },
      }),
    );
    await vi.waitFor(() =>
      expect(sent(child).at(-1)).toMatchObject({
        id: "grant_1",
        kind: "grant",
        grant: { ok: true, grant: "allow" },
      }),
    );
  });
});
