import { afterEach, describe, expect, it, vi } from "vitest";

import { createSnapshotSyncScheduler } from "./snapshotSyncScheduler";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("createSnapshotSyncScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces repeated debounced requests into a single sync", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = createSnapshotSyncScheduler({
      debounceMs: 75,
      run,
    });

    scheduler.requestDebounced();
    scheduler.requestDebounced();
    scheduler.requestDebounced();

    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(74);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs one debounced follow-up sync for events that arrive during an active sync", async () => {
    vi.useFakeTimers();
    const firstRun = createDeferred();
    let callCount = 0;
    const run = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstRun.promise;
      }
    });
    const scheduler = createSnapshotSyncScheduler({
      debounceMs: 75,
      run,
    });

    scheduler.requestDebounced();
    await vi.advanceTimersByTimeAsync(75);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.requestDebounced();
    scheduler.requestDebounced();

    firstRun.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(75);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("promotes a waiting sync to immediate and waits until the queue is idle", async () => {
    vi.useFakeTimers();
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    let callCount = 0;
    const run = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstRun.promise;
        return;
      }
      if (callCount === 2) {
        await secondRun.promise;
      }
    });
    const scheduler = createSnapshotSyncScheduler({
      debounceMs: 75,
      run,
    });

    scheduler.requestDebounced();
    await vi.advanceTimersByTimeAsync(75);
    expect(run).toHaveBeenCalledTimes(1);

    let settled = false;
    const immediateSync = scheduler.requestImmediate().then(() => {
      settled = true;
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    firstRun.resolve();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    secondRun.resolve();
    await immediateSync;
    expect(settled).toBe(true);
  });
});
