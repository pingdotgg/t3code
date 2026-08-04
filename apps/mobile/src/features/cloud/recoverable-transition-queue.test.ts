import { describe, expect, it } from "vite-plus/test";

import { createRecoverableTransitionQueue } from "./recoverable-transition-queue";

describe("recoverable transition queue", () => {
  it("keeps a failed transition pending and retries it before activation", async () => {
    const queue = createRecoverableTransitionQueue();
    let attempts = 0;
    const transition = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("storage unavailable")) : Promise.resolve();
    };

    await expect(queue.enqueue(transition)).rejects.toThrow("storage unavailable");
    expect(queue.hasPending()).toBe(true);

    await queue.retryPending();
    expect(attempts).toBe(2);
    expect(queue.hasPending()).toBe(false);
  });

  it("coalesces concurrent retries of the same pending transition", async () => {
    const queue = createRecoverableTransitionQueue();
    let attempts = 0;
    let release!: () => void;
    const transition = () => {
      attempts += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const first = queue.enqueue(transition);
    const second = queue.retryPending();
    expect(attempts).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
  });

  it("retries a failed active transition before a transition queued behind it", async () => {
    const queue = createRecoverableTransitionQueue();
    const order: string[] = [];
    let firstAttempts = 0;
    const first = queue.enqueue(() => {
      firstAttempts += 1;
      order.push(`first:${String(firstAttempts)}`);
      return firstAttempts === 1
        ? Promise.reject(new Error("storage unavailable"))
        : Promise.resolve();
    });
    const second = queue.enqueue(async () => {
      order.push("second");
    });

    await expect(first).rejects.toThrow("storage unavailable");
    await second;
    expect(order).toEqual(["first:1", "first:2", "second"]);
    expect(queue.hasPending()).toBe(false);
  });
});
