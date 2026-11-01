import { describe, expect, it } from "vite-plus/test";

import { CaptureLock } from "./CaptureLock.ts";

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CaptureLock", () => {
  it("keeps the capture ahead exclusive when a waiting capture gives up", async () => {
    const lock = new CaptureLock();
    const ahead = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = lock.run(async () => {
      events.push("first started");
      await ahead.promise;
      events.push("first finished");
    });
    const giveUp = new AbortController();
    const expired = lock.run(async () => {
      events.push("expired started");
    }, giveUp.signal);
    const reason = new Error("expired");
    giveUp.abort(reason);
    await expect(expired).rejects.toBe(reason);

    const next = lock.run(async () => {
      events.push("next started");
    });
    await settle();
    expect(events).toEqual(["first started"]);

    ahead.resolve();
    await Promise.all([first, next]);
    expect(events).toEqual(["first started", "first finished", "next started"]);
  });

  it("frees the lock when a running capture that never settles gives up", async () => {
    const lock = new CaptureLock();
    const giveUp = new AbortController();
    const stalled = lock.run(() => new Promise<never>(() => {}), giveUp.signal);
    await settle();
    const reason = new Error("expired");
    giveUp.abort(reason);

    await expect(stalled).rejects.toBe(reason);
    await expect(lock.run(async () => "next")).resolves.toBe("next");
  });
});
