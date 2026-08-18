import type { DesktopNotificationTarget } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { createDesktopNotificationTargetDrain } from "./desktopNotificationTarget.logic";

const TARGET = {
  environmentId: "primary",
  threadId: "thread-1",
} as unknown as DesktopNotificationTarget;

function makeHarness() {
  const opened: DesktopNotificationTarget[] = [];
  const pending: Array<DesktopNotificationTarget | null> = [];
  let consumeCount = 0;
  let unsubscribeCount = 0;
  let listener: (() => void) | null = null;
  const settled: Promise<unknown>[] = [];

  const drain = createDesktopNotificationTargetDrain({
    consume: () => {
      consumeCount += 1;
      const promise = Promise.resolve(pending.shift() ?? null);
      settled.push(promise);
      return promise;
    },
    onTarget: (target) => {
      opened.push(target);
    },
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribeCount += 1;
      };
    },
  });

  return {
    drain,
    opened,
    pending,
    signal: () => listener?.(),
    get consumeCount() {
      return consumeCount;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
    flush: () => Promise.all(settled).then(() => undefined),
  };
}

describe("createDesktopNotificationTargetDrain", () => {
  it("pulls once at construction, for a click that landed before the window existed", async () => {
    const harness = makeHarness();

    assert.strictEqual(harness.consumeCount, 1);
    await harness.flush();
    assert.deepStrictEqual(harness.opened, []);
  });

  it("pulls again when main signals a parked target", async () => {
    const harness = makeHarness();
    await harness.flush();

    harness.pending.push(TARGET);
    harness.signal();
    await harness.flush();

    assert.deepStrictEqual(harness.opened, [TARGET]);
  });

  it("drops a pull that resolves after disposal", async () => {
    const harness = makeHarness();
    harness.pending.push(TARGET);

    harness.signal();
    // Disposed while the pull is still in flight: navigating now would yank the
    // route out from under whatever replaced this mount.
    harness.drain.dispose();
    await harness.flush();

    assert.deepStrictEqual(harness.opened, []);
  });

  it("unsubscribes on disposal", () => {
    const harness = makeHarness();

    harness.drain.dispose();

    assert.strictEqual(harness.unsubscribeCount, 1);
  });
});
