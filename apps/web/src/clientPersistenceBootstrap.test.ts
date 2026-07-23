import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitForClientPersistenceHydration } from "./clientPersistenceBootstrap";

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
});
