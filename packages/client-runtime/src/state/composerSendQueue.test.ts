import { describe, expect, it } from "vite-plus/test";

import { makeComposerSendQueue } from "./composerSendQueue.ts";

describe("makeComposerSendQueue", () => {
  it("keeps a message that was typed while a send was in flight", () => {
    const queue = makeComposerSendQueue<string>({ now: () => 1_000 });

    queue.enqueue({ id: "m1", payload: "and also check the logs" });

    expect(queue.size()).toBe(1);
    expect(queue.peek()[0]?.payload).toBe("and also check the logs");
  });

  it("drains in the order the messages were typed", () => {
    let now = 1_000;
    const queue = makeComposerSendQueue<string>({ now: () => now });
    queue.enqueue({ id: "m1", payload: "first" });
    now = 2_000;
    queue.enqueue({ id: "m2", payload: "second" });

    const drained = queue.drain();

    expect(drained.map((message) => message.payload)).toEqual(["first", "second"]);
    expect(drained[0]?.queuedAtMs).toBe(1_000);
    expect(queue.size()).toBe(0);
  });

  it("empties the queue when it is drained", () => {
    const queue = makeComposerSendQueue<string>({ now: () => 1_000 });
    queue.enqueue({ id: "m1", payload: "first" });

    queue.drain();

    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("puts a failed message back at the front", () => {
    const queue = makeComposerSendQueue<string>({ now: () => 1_000 });
    queue.enqueue({ id: "m1", payload: "first" });
    queue.enqueue({ id: "m2", payload: "second" });

    const drained = queue.drain();
    const first = drained[0];
    expect(first).toBeDefined();
    queue.restore(first!);
    queue.enqueue({ id: "m3", payload: "third" });

    expect(queue.peek().map((message) => message.payload)).toEqual(["first", "third"]);
  });

  it("keeps the queued order when several unsent messages are restored", () => {
    // Restoring goes to the FRONT, so restoring a remainder in the order it
    // was drained would reverse it. The caller restores from last to first.
    const queue = makeComposerSendQueue<string>({ now: () => 1_000 });
    queue.enqueue({ id: "m1", payload: "first" });
    queue.enqueue({ id: "m2", payload: "second" });
    queue.enqueue({ id: "m3", payload: "third" });

    const drained = queue.drain();
    const unsent = drained.slice(1);
    for (const message of unsent.toReversed()) {
      queue.restore(message);
    }

    expect(queue.peek().map((message) => message.payload)).toEqual(["second", "third"]);
  });

  it("does not lose a message that is restored twice", () => {
    const queue = makeComposerSendQueue<string>({ now: () => 1_000 });
    queue.enqueue({ id: "m1", payload: "first" });

    const [first] = queue.drain();
    queue.restore(first!);
    queue.restore(first!);

    expect(queue.size()).toBe(2);
    expect(queue.peek().map((message) => message.payload)).toEqual(["first", "first"]);
  });

  it("carries a payload the queue does not interpret", () => {
    const queue = makeComposerSendQueue<{ readonly text: string; readonly files: number }>({
      now: () => 1_000,
    });

    queue.enqueue({ id: "m1", payload: { text: "hi", files: 2 } });

    expect(queue.peek()[0]?.payload).toEqual({ text: "hi", files: 2 });
  });
});
