import type * as Electron from "electron";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ActiveWindow } from "./ActiveWindow.ts";
import type { RegionSnapShotChild, RegionSnapShotProcess } from "./RegionSnapShot.ts";

const { createFromBufferMock, resizeMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  resizeMock: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: createFromBufferMock },
}));

import {
  captureRegionWindowSnapshot,
  makeRegionSnapShotPool,
  startRegionSnapShotProcess,
} from "./RegionSnapShot.ts";

beforeEach(() => {
  vi.clearAllMocks();
  createFromBufferMock.mockReturnValue({ resize: resizeMock });
});

const active = {
  title: "Editor",
  owner: { name: "Editor", processId: 123 },
  bounds: { x: 10, y: 20, width: 800, height: 600 },
} as ActiveWindow;

it("returns a small capture's PNG untouched", async () => {
  const png = Buffer.from([1, 2, 3]);
  const capture = vi.fn(async () => ({ width: 400, height: 300, png }));
  const region = { x: 5, y: 10, width: 400, height: 300 };

  const result = await captureRegionWindowSnapshot({ capture }, active, region, region);

  assert.deepEqual(capture.mock.calls, [[region]]);
  assert.strictEqual(result.png, png);
  assert.deepEqual(result.source, { name: "Editor" });
  assert.lengthOf(createFromBufferMock.mock.calls, 0);
});

it.each([
  { width: 600, height: 400, expected: { width: 240, height: 160 } },
  { width: 400, height: 600, expected: { width: 107, height: 160 } },
  { width: 600, height: 1, expected: { width: 256, height: 1 } },
])(
  "bounds $width x $height physical pixels before encoding",
  async ({ width, height, expected }) => {
    const png = Buffer.from([1, 2, 3]);
    const resizedPng = Buffer.from([4, 5, 6]);
    const capture = vi.fn(async () => ({ width, height, png }));
    resizeMock.mockReturnValue({ toPNG: () => resizedPng });

    const result = await captureRegionWindowSnapshot({ capture }, active, active.bounds, {
      width: 256,
      height: 160,
    });

    assert.deepEqual(createFromBufferMock.mock.calls, [[png]]);
    assert.deepEqual(resizeMock.mock.calls, [[{ ...expected, quality: "best" }]]);
    assert.strictEqual(result.png, resizedPng);
  },
);

function fakeChild() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const exitListeners: Array<() => void> = [];
  const send = vi.fn();
  const kill = vi.fn();
  const child: RegionSnapShotChild = {
    send,
    onMessage: (listener) => messageListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    kill,
  };
  return {
    child,
    send,
    kill,
    emit: (message: unknown) => {
      for (const listener of messageListeners) listener(message);
    },
    exit: () => {
      for (const listener of exitListeners) listener();
    },
  };
}

const region = { x: 0, y: 0, width: 2, height: 1 };

it("resolves the decoded capture once the child is ready and replies", async () => {
  const fake = fakeChild();
  const fork = vi.fn(() => fake.child);
  const png = Buffer.from([9, 8, 7]);
  const child = startRegionSnapShotProcess("worker.cjs", fork);
  assert.deepEqual(fork.mock.calls, [["worker.cjs"]]);
  assert.isTrue(child.alive);

  const capture = child.capture(region);
  await Promise.resolve();
  assert.lengthOf(fake.send.mock.calls, 0);
  fake.emit("ready");
  await vi.waitFor(() => assert.deepEqual(fake.send.mock.calls, [[{ region }]]));
  fake.emit({ type: "result", width: 2, height: 1, png: png.toString("base64") });

  assert.deepEqual(await capture, { width: 2, height: 1, png });
  assert.isFalse(child.alive);
  assert.lengthOf(fake.kill.mock.calls, 1);
});

it("rejects with the child's error message", async () => {
  const fake = fakeChild();
  const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
  const capture = child.capture(region);
  fake.emit("ready");
  fake.emit({ type: "error", message: "Screen capture failed" });

  await expect(capture).rejects.toThrow("Screen capture failed");
  assert.isFalse(child.alive);
});

it("rejects when the child exits before replying", async () => {
  const fake = fakeChild();
  const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
  const capture = child.capture(region);
  fake.emit("ready");
  fake.exit();

  await expect(capture).rejects.toThrow(/helper exited/);
});

it("serves a single capture per child", async () => {
  const fake = fakeChild();
  const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
  const first = child.capture(region);
  fake.emit("ready");
  await vi.waitFor(() => assert.lengthOf(fake.send.mock.calls, 1));
  fake.emit({ type: "result", width: 1, height: 1, png: Buffer.from([1]).toString("base64") });
  await first;

  await expect(child.capture(region)).rejects.toThrow(/already used/);
  assert.lengthOf(fake.send.mock.calls, 1);
});

it("cancels a pending capture on close and kills the child", async () => {
  const fake = fakeChild();
  const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
  const capture = child.capture(region);
  child.close();

  await expect(capture).rejects.toThrow(/cancelled/);
  assert.lengthOf(fake.kill.mock.calls, 1);
  assert.isFalse(child.alive);
  fake.emit("ready");
  assert.lengthOf(fake.send.mock.calls, 0);
});

it("reports an unavailable helper when the child cannot be forked", async () => {
  const child = startRegionSnapShotProcess("worker.cjs", () => {
    throw new Error("fork failed");
  });

  assert.isFalse(child.alive);
  await expect(child.capture(region)).rejects.toThrow(/unavailable/);
});

it("times out a stalled capture", async () => {
  vi.useFakeTimers();
  try {
    const fake = fakeChild();
    const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
    const failure = expect(child.capture(region)).rejects.toThrow(/timed out/);
    fake.emit("ready");
    await vi.advanceTimersByTimeAsync(15_000);

    await failure;
    assert.lengthOf(fake.kill.mock.calls, 1);
  } finally {
    vi.useRealTimers();
  }
});

function fakeProcess() {
  const result = Promise.withResolvers<{ width: number; height: number; png: Buffer }>();
  void result.promise.catch(() => undefined);
  let alive = true;
  const close = vi.fn(() => {
    alive = false;
    result.reject(new Error("Windows window capture cancelled."));
  });
  const capture = vi.fn((_region: Electron.Rectangle) => result.promise);
  const process: RegionSnapShotProcess = {
    get alive() {
      return alive;
    },
    capture,
    close,
  };
  return {
    process,
    capture,
    close,
    resolve: (value: { width: number; height: number; png: Buffer }) => {
      alive = false;
      result.resolve(value);
    },
  };
}

function fakePool() {
  const processes: Array<ReturnType<typeof fakeProcess>> = [];
  const start = vi.fn(() => {
    const process = fakeProcess();
    processes.push(process);
    return process.process;
  });
  return { pool: makeRegionSnapShotPool("worker.cjs", start), processes, start };
}

it("warms one standby child and keeps it while alive", () => {
  const { pool, start } = fakePool();

  pool.warm();
  pool.warm();

  assert.deepEqual(start.mock.calls, [["worker.cjs"]]);
});

it("captures with the standby child and warms a replacement afterwards", async () => {
  const { pool, processes, start } = fakePool();
  pool.warm();
  const shot = { width: 1, height: 1, png: Buffer.from([1]) };

  const capture = pool.capture(region);
  assert.deepEqual(processes[0]!.capture.mock.calls, [[region]]);
  assert.lengthOf(start.mock.calls, 1);
  processes[0]!.resolve(shot);

  assert.deepEqual(await capture, shot);
  assert.lengthOf(start.mock.calls, 2);
  assert.lengthOf(processes[1]!.capture.mock.calls, 0);
});

it("starts a child on demand when no standby is warm", async () => {
  const { pool, processes, start } = fakePool();
  const shot = { width: 1, height: 1, png: Buffer.from([1]) };

  const capture = pool.capture(region);
  assert.lengthOf(start.mock.calls, 1);
  processes[0]!.resolve(shot);

  assert.deepEqual(await capture, shot);
});

it("rejects a second capture while one is in flight", async () => {
  const { pool, processes } = fakePool();
  const first = pool.capture(region);

  await expect(pool.capture(region)).rejects.toThrow(/still in progress/);
  assert.lengthOf(processes, 1);

  processes[0]!.resolve({ width: 1, height: 1, png: Buffer.from([1]) });
  await first;
});

it("cools the standby child", () => {
  const { pool, processes, start } = fakePool();
  pool.warm();

  pool.cool();

  assert.lengthOf(processes[0]!.close.mock.calls, 1);
  pool.warm();
  assert.lengthOf(start.mock.calls, 2);
});

it("closes the standby and the in-flight child", async () => {
  const { pool, processes } = fakePool();
  pool.warm();
  const capture = pool.capture(region);
  pool.warm();
  assert.lengthOf(processes, 2);

  pool.close();

  await expect(capture).rejects.toThrow(/cancelled/);
  assert.lengthOf(processes[0]!.close.mock.calls, 1);
  assert.lengthOf(processes[1]!.close.mock.calls, 1);
  await expect(pool.capture(region)).rejects.toThrow(/unavailable/);
  assert.lengthOf(processes, 2);
});
