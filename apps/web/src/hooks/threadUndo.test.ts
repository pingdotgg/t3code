import { describe, expect, it } from "vite-plus/test";

import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

describe("planThreadUndo", () => {
  it("restores a pull request snooze with its watch", () => {
    const snoozedUntil = "9999-01-01T00:00:00.000Z";
    expect(
      ThreadUndo.planThreadUndo("unpin", {
        snoozedUntil,
        pullRequests: [{ snoozeWatch: { wakeOn: "review" } }],
      }),
    ).toContainEqual({ action: "snooze", snoozedUntil, wakeOnPullRequest: "review" });
    expect(ThreadUndo.planThreadUndo("unpin", { snoozedUntil, pullRequests: [{}] })).toContainEqual(
      { action: "snooze", snoozedUntil },
    );
  });
});

describe("thread action ownership", () => {
  it("does not revive the first Undo after a later pin and unpin", () => {
    const firstUnpin = ThreadUndo.begin("pin", "env/thread");
    ThreadUndo.invalidate("pin", "env/thread");
    const secondUnpin = ThreadUndo.begin("pin", "env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
  });

  it("expires an Undo without invalidating another environment or thread", () => {
    const first = ThreadUndo.begin("pin", "one/thread");
    const otherEnvironment = ThreadUndo.begin("pin", "two/thread");
    const otherThread = ThreadUndo.begin("pin", "one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });
});
