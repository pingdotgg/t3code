import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  waitForClientPersistenceFlushes,
  waitForClientPersistenceHydration,
} from "./clientPersistenceBootstrap";

describe("waitForClientPersistenceHydration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues as soon as every hydration settles", async () => {
    await expect(
      waitForClientPersistenceHydration(
        [Promise.resolve(), Promise.reject(new Error("read failed"))],
        100,
      ),
    ).resolves.toBe("hydrated");
  });

  it("fails open when a desktop IPC hydration never settles", async () => {
    vi.useFakeTimers();
    const hydration = waitForClientPersistenceHydration([new Promise(() => undefined)], 100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(hydration).resolves.toBe("timed-out");
  });

  it("waits for every renderer persistence flush before reporting a failure", async () => {
    let finishSlowFlush!: () => void;
    const slowFlush = new Promise<void>((resolve) => {
      finishSlowFlush = resolve;
    });
    const flush = waitForClientPersistenceFlushes([
      Promise.reject(new Error("client settings failed")),
      slowFlush,
    ]);
    let settled = false;
    void flush.catch(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    finishSlowFlush();

    await expect(flush).rejects.toThrow("One or more client persistence flushes failed.");
  });
});
