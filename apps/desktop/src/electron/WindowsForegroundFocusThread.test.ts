import { assert, beforeEach, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const workerConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("node:worker_threads", () => ({
  Worker: function Worker(...args: ReadonlyArray<unknown>) {
    return workerConstructorMock(...args);
  },
}));

import { startWindowsForegroundFocusThread } from "./WindowsForegroundFocusThread.ts";

const makeWorker = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 0),
    unref: vi.fn(),
  });

let worker = makeWorker();
const target = {
  windowId: 7,
  processId: 42,
  title: "T3 Code (Dev)",
  bounds: { x: 100, y: 50, width: 1_200, height: 800 },
  contentBounds: { x: 108, y: 50, width: 1_184, height: 792 },
};

beforeEach(() => {
  worker = makeWorker();
  workerConstructorMock.mockReset().mockReturnValue(worker);
});

it("queues focus until the helper is ready", async () => {
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  const focused = thread.focus(target);

  assert.lengthOf(worker.postMessage.mock.calls, 0);
  worker.emit("message", "ready");
  assert.deepEqual(worker.postMessage.mock.calls[0]?.[0], {
    type: "focus",
    requestId: 1,
    target,
  });
  worker.emit("message", { type: "result", requestId: 1, focused: true });

  assert.isTrue(await focused);
  assert.deepEqual(workerConstructorMock.mock.calls, [["focus.cjs"]]);
  thread.close();
});

it("fails pending focus when the helper exits", async () => {
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  const focused = thread.focus(target);

  worker.emit("exit", 1);

  assert.isFalse(await focused);
  assert.lengthOf(workerConstructorMock.mock.calls, 1);
  const prepared = thread.prepare(target);
  replacement.emit("message", "ready");
  replacement.emit("message", { type: "result", requestId: 2, focused: true });
  assert.isTrue(await prepared);
  assert.lengthOf(workerConstructorMock.mock.calls, 2);
  thread.close();
});

it("replaces a timed-out helper before accepting more work", async () => {
  vi.useFakeTimers();
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");

  try {
    worker.emit("message", "ready");
    const focused = thread.focus(target);
    await vi.advanceTimersByTimeAsync(1_000);

    assert.isFalse(await focused);
    assert.lengthOf(worker.terminate.mock.calls, 1);
    assert.lengthOf(workerConstructorMock.mock.calls, 2);

    replacement.emit("message", "ready");
    const prepared = thread.prepare(target);
    assert.deepEqual(replacement.postMessage.mock.calls[0]?.[0], {
      type: "prepare",
      requestId: 2,
      target,
    });
    replacement.emit("message", { type: "result", requestId: 2, focused: true });
    assert.isTrue(await prepared);
  } finally {
    thread.close();
    vi.useRealTimers();
  }
});
