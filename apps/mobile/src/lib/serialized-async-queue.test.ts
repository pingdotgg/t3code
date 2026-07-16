import { describe, expect, it } from "@effect/vitest";

import { SerializedAsyncQueue } from "./serialized-async-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SerializedAsyncQueue", () => {
  it("does not let a newer operation overtake an in-flight operation", async () => {
    const queue = new SerializedAsyncQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a rejected operation", async () => {
    const queue = new SerializedAsyncQueue();
    const first = queue.run(async () => {
      throw new Error("failed");
    });
    const second = queue.run(async () => "recovered");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("recovered");
  });
});
