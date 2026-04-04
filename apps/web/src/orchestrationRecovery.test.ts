import { describe, expect, it } from "vitest";

import {
  createOrchestrationRecoveryCoordinator,
  deriveReplayRetryDecision,
} from "./orchestrationRecovery";

describe("createOrchestrationRecoveryCoordinator", () => {
  it("defers live events until bootstrap completes and then requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");

    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("classifies sequence gaps as recovery-only replay work", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(5)).toBe("recover");
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "replay",
      reason: "sequence-gap",
    });
  });

  it("tracks live event batches without entering recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(4)).toBe("apply");
    expect(coordinator.markEventBatchApplied([{ sequence: 4 }])).toEqual([{ sequence: 4 }]);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 4,
      highestObservedSequence: 4,
      bootstrapped: true,
      inFlight: null,
    });
  });

  it("requests another replay when deferred events arrive during replay recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.classifyDomainEvent(7);
    coordinator.markEventBatchApplied([{ sequence: 4 }, { sequence: 5 }, { sequence: 6 }]);

    expect(coordinator.completeReplayRecovery()).toEqual({
      replayMadeProgress: true,
      shouldReplay: true,
    });
  });

  it("retries replay when no progress was made but higher live sequences were observed", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");

    expect(coordinator.completeReplayRecovery()).toEqual({
      replayMadeProgress: false,
      shouldReplay: true,
    });
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 3,
      highestObservedSequence: 5,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("does not request another replay when a replay made no progress and nothing newer was observed", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.beginReplayRecovery("sequence-gap");

    expect(coordinator.completeReplayRecovery()).toEqual({
      replayMadeProgress: false,
      shouldReplay: false,
    });
  });

  it("marks replay failure as unbootstrapped so snapshot fallback is recovery-only", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.failReplayRecovery();

    expect(coordinator.getState()).toMatchObject({
      bootstrapped: false,
      inFlight: null,
    });
    expect(coordinator.beginSnapshotRecovery("replay-failed")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "snapshot",
      reason: "replay-failed",
    });
  });

  it("keeps enough state to explain why bootstrap snapshot recovery requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");
    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);

    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("reports skip state when snapshot recovery is requested while replay is in flight", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      pendingReplay: true,
      inFlight: {
        kind: "replay",
        reason: "sequence-gap",
      },
    });
  });
});

describe("deriveReplayRetryDecision", () => {
  it("retries immediately when replay made progress", () => {
    expect(
      deriveReplayRetryDecision({
        previousTracker: {
          attempts: 2,
          latestSequence: 3,
          highestObservedSequence: 5,
        },
        completion: {
          replayMadeProgress: true,
          shouldReplay: true,
        },
        recoveryState: {
          latestSequence: 5,
          highestObservedSequence: 5,
        },
        baseDelayMs: 100,
        maxNoProgressRetries: 3,
      }),
    ).toEqual({
      shouldRetry: true,
      delayMs: 0,
      tracker: null,
    });
  });

  it("caps no-progress retries for the same frontier", () => {
    const first = deriveReplayRetryDecision({
      previousTracker: null,
      completion: {
        replayMadeProgress: false,
        shouldReplay: true,
      },
      recoveryState: {
        latestSequence: 3,
        highestObservedSequence: 5,
      },
      baseDelayMs: 100,
      maxNoProgressRetries: 3,
    });

    const second = deriveReplayRetryDecision({
      previousTracker: first.tracker,
      completion: {
        replayMadeProgress: false,
        shouldReplay: true,
      },
      recoveryState: {
        latestSequence: 3,
        highestObservedSequence: 5,
      },
      baseDelayMs: 100,
      maxNoProgressRetries: 3,
    });

    const third = deriveReplayRetryDecision({
      previousTracker: second.tracker,
      completion: {
        replayMadeProgress: false,
        shouldReplay: true,
      },
      recoveryState: {
        latestSequence: 3,
        highestObservedSequence: 5,
      },
      baseDelayMs: 100,
      maxNoProgressRetries: 3,
    });

    const fourth = deriveReplayRetryDecision({
      previousTracker: third.tracker,
      completion: {
        replayMadeProgress: false,
        shouldReplay: true,
      },
      recoveryState: {
        latestSequence: 3,
        highestObservedSequence: 5,
      },
      baseDelayMs: 100,
      maxNoProgressRetries: 3,
    });

    expect(first).toEqual({
      shouldRetry: true,
      delayMs: 100,
      tracker: {
        attempts: 1,
        latestSequence: 3,
        highestObservedSequence: 5,
      },
    });
    expect(second).toEqual({
      shouldRetry: true,
      delayMs: 200,
      tracker: {
        attempts: 2,
        latestSequence: 3,
        highestObservedSequence: 5,
      },
    });
    expect(third).toEqual({
      shouldRetry: true,
      delayMs: 400,
      tracker: {
        attempts: 3,
        latestSequence: 3,
        highestObservedSequence: 5,
      },
    });
    expect(fourth).toEqual({
      shouldRetry: false,
      delayMs: 0,
      tracker: null,
    });
  });

  it("resets the retry budget when the replay frontier changes", () => {
    const exhausted = {
      attempts: 3,
      latestSequence: 3,
      highestObservedSequence: 5,
    };

    expect(
      deriveReplayRetryDecision({
        previousTracker: exhausted,
        completion: {
          replayMadeProgress: false,
          shouldReplay: true,
        },
        recoveryState: {
          latestSequence: 3,
          highestObservedSequence: 6,
        },
        baseDelayMs: 100,
        maxNoProgressRetries: 3,
      }),
    ).toEqual({
      shouldRetry: true,
      delayMs: 100,
      tracker: {
        attempts: 1,
        latestSequence: 3,
        highestObservedSequence: 6,
      },
    });
  });
});
