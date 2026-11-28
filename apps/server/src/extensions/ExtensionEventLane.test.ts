import { it, expect } from "vite-plus/test";
import { ExtensionEventLane } from "./ExtensionEventLane.ts";

it("delivers hooks in order within count and byte budgets, continues after failures, and discards queued work on close", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered: number[] = [];
  const errors: unknown[] = [];
  let overflows = 0;
  const lane = new ExtensionEventLane({
    maxEvents: 2,
    maxBytes: 4,
    onError: (cause) => errors.push(cause),
    onOverflow: () => {
      overflows++;
    },
  });
  const first = lane.enqueue(2, async () => {
    entered.resolve();
    await release.promise;
    delivered.push(1);
    throw new Error("hook failed");
  });
  await entered.promise;
  const second = lane.enqueue(2, async () => {
    delivered.push(2);
  });
  await lane.enqueue(1, async () => {
    delivered.push(3);
  });
  expect(overflows).toBe(1);
  expect(delivered).toEqual([]);
  release.resolve();
  await Promise.all([first, second]);
  expect(delivered).toEqual([1, 2]);
  expect(errors).toHaveLength(1);
  await lane.enqueue(5, async () => {
    delivered.push(4);
  });
  expect(overflows).toBe(2);
  const queued = lane.enqueue(1, async () => {
    delivered.push(5);
  });
  lane.close();
  await queued;
  await lane.enqueue(1, async () => {
    delivered.push(6);
  });
  expect(delivered).toEqual([1, 2]);
});
