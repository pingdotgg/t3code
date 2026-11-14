import type * as Electron from "electron";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

import type { RegionSnapShotChild, RegionSnapShotProcess } from "./RegionSnapShot.ts";

const { createFromBufferMock, resizeMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  resizeMock: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: createFromBufferMock },
}));

import { makeRegionSnapShotPool, startRegionSnapShotProcess } from "./RegionSnapShot.ts";

beforeEach(() => {
  vi.clearAllMocks();
  createFromBufferMock.mockReturnValue({ resize: resizeMock });
});

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

it("rejects when the child exits before replying", async () => {
  const fake = fakeChild();
  const child = startRegionSnapShotProcess("worker.cjs", () => fake.child);
  const capture = child.capture(region);
  fake.emit("ready");
  fake.exit();

  await expect(capture).rejects.toThrow(/helper exited/);
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

it("rejects a second capture while one is in flight", async () => {
  const { pool, processes } = fakePool();
  const first = pool.capture(region);

  await expect(pool.capture(region)).rejects.toThrow(/still in progress/);
  assert.lengthOf(processes, 1);

  processes[0]!.resolve({ width: 1, height: 1, png: Buffer.from([1]) });
  await first;
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
