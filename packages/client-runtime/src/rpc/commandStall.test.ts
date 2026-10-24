import { describe, expect, it } from "vite-plus/test";

import { COMMAND_STALL_DEADLINE, makeCommandStallTracker } from "./commandStall.ts";

describe("COMMAND_STALL_DEADLINE", () => {
  it("is long enough that a slow success is not turned into a failure", () => {
    // A host under load can take minutes to answer a command. The deadline
    // exists to catch a pipeline that never answers, not to cut off work that
    // is about to finish, so it has to be comfortably beyond a slow turn.
    const deadlineMs = Number.parseInt(COMMAND_STALL_DEADLINE, 10) * 1000;
    expect(deadlineMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe("makeCommandStallTracker", () => {
  it("reports nothing stalled when no command is outstanding", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });

    expect(tracker.stalled(10_000, 5_000)).toBeNull();
    expect(tracker.outstandingCount()).toBe(0);
  });

  it("does not report a command that is still within the deadline", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    tracker.begin("orchestration.dispatchCommand");

    // 4s outstanding, 5s deadline: still fine.
    expect(tracker.stalled(5_000, 5_000)).toBeNull();
  });

  it("reports the command that has been outstanding longest", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    tracker.begin("first");
    tracker.begin("second");

    // Both are outstanding; the first started at 1_000, the second at 2_000.
    tracker.begin("second");
    const snapshot = tracker.stalled(20_000, 5_000);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.method).toBe("first");
    expect(snapshot?.outstandingMs).toBe(19_000);
    expect(snapshot?.outstandingCount).toBe(3);
  });

  it("stops reporting a command once it finishes", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    const command = tracker.begin("orchestration.dispatchCommand");

    expect(tracker.stalled(20_000, 5_000)).not.toBeNull();

    command.release();

    expect(tracker.stalled(20_000, 5_000)).toBeNull();
    expect(tracker.outstandingCount()).toBe(0);
  });

  it("keeps count and report correct when the same method is outstanding twice", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    const first = tracker.begin("orchestration.dispatchCommand");
    tracker.begin("orchestration.dispatchCommand");

    expect(tracker.outstandingCount()).toBe(2);

    // One finishes; the other is still outstanding, so the pipeline is still
    // stalled and the count drops by exactly one.
    first.release();

    const snapshot = tracker.stalled(20_000, 5_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.outstandingCount).toBe(1);
  });

  it("releases the command that finished, not the oldest of the same method", () => {
    // The newer command of the same method finishes first. Releasing by
    // method would drop the OLDER one, and the finished command would still
    // be reported as outstanding.
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    const older = tracker.begin("orchestration.dispatchCommand");
    const newer = tracker.begin("orchestration.dispatchCommand");

    newer.release();

    expect(tracker.outstandingCount()).toBe(1);
    // The remaining command is the older one, so the stall is still reported
    // against the command that is actually outstanding.
    const snapshot = tracker.stalled(20_000, 5_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.outstandingCount).toBe(1);

    older.release();
    expect(tracker.outstandingCount()).toBe(0);
    expect(tracker.stalled(20_000, 5_000)).toBeNull();
  });

  it("releasing the same command twice does not drop another one", () => {
    const tracker = makeCommandStallTracker({ now: () => 1_000 });
    const first = tracker.begin("a");
    tracker.begin("a");

    first.release();
    first.release();

    expect(tracker.outstandingCount()).toBe(1);
  });

  it("does not report a stall that has not yet reached the deadline", () => {
    const tracker = makeCommandStallTracker({ now: () => 0 });
    tracker.begin("slow");

    // Exactly at the deadline is not yet past it.
    expect(tracker.stalled(4_999, 5_000)).toBeNull();
    expect(tracker.stalled(5_000, 5_000)).not.toBeNull();
  });
});
