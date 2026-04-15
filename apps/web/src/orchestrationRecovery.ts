export type OrchestrationRecoveryReason =
  | "bootstrap"
  | "sequence-gap"
  | "resubscribe"
  | "replay-failed";

export interface OrchestrationRecoveryPhase {
  kind: "snapshot" | "replay";
  reason: OrchestrationRecoveryReason;
}

export interface OrchestrationRecoveryState {
  latestSequence: number;
  highestObservedSequence: number;
  bootstrapped: boolean;
  pendingReplay: boolean;
  inFlight: OrchestrationRecoveryPhase | null;
}

export interface ReplayRecoveryCompletion {
  replayMadeProgress: boolean;
  shouldReplay: boolean;
}

export interface ReplayRetryTracker {
  attempts: number;
  latestSequence: number;
  highestObservedSequence: number;
}

export interface ReplayRetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  tracker: ReplayRetryTracker | null;
}

type SequencedEvent = Readonly<{ sequence: number }>;

export function deriveReplayRetryDecision(input: {
  previousTracker: ReplayRetryTracker | null;
  completion: ReplayRecoveryCompletion;
  recoveryState: Pick<OrchestrationRecoveryState, "latestSequence" | "highestObservedSequence">;
  baseDelayMs: number;
  maxNoProgressRetries: number;
}): ReplayRetryDecision {
  if (!input.completion.shouldReplay) {
    return {
      shouldRetry: false,
      delayMs: 0,
      tracker: null,
    };
  }

  if (input.completion.replayMadeProgress) {
    return {
      shouldRetry: true,
      delayMs: 0,
      tracker: null,
    };
  }

  const previousTracker = input.previousTracker;
  const sameFrontier =
    previousTracker !== null &&
    previousTracker.latestSequence === input.recoveryState.latestSequence &&
    previousTracker.highestObservedSequence === input.recoveryState.highestObservedSequence;

  const attempts = sameFrontier && previousTracker !== null ? previousTracker.attempts + 1 : 1;
  if (attempts > input.maxNoProgressRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      tracker: null,
    };
  }

  return {
    shouldRetry: true,
    delayMs: input.baseDelayMs * 2 ** (attempts - 1),
    tracker: {
      attempts,
      latestSequence: input.recoveryState.latestSequence,
      highestObservedSequence: input.recoveryState.highestObservedSequence,
    },
  };
}

export function createOrchestrationRecoveryCoordinator() {
  let state: OrchestrationRecoveryState = {
    latestSequence: 0,
    highestObservedSequence: 0,
    bootstrapped: false,
    pendingReplay: false,
    inFlight: null,
  };
  let replayStartSequence: number | null = null;

  const snapshotState = (): OrchestrationRecoveryState => ({
    ...state,
    ...(state.inFlight ? { inFlight: { ...state.inFlight } } : {}),
  });

  const observeSequence = (sequence: number) => {
    state.highestObservedSequence = Math.max(state.highestObservedSequence, sequence);
  };

  const resolveReplayNeedAfterRecovery = () => {
    const pendingReplayBeforeReset = state.pendingReplay;
    const observedAhead = state.highestObservedSequence > state.latestSequence;
    const shouldReplay = pendingReplayBeforeReset || observedAhead;
    state.pendingReplay = false;
    return {
      shouldReplay,
      pendingReplayBeforeReset,
      observedAhead,
    };
  };

  return {
    getState(): OrchestrationRecoveryState {
      return snapshotState();
    },

    classifyDomainEvent(sequence: number): "ignore" | "defer" | "recover" | "apply" {
      observeSequence(sequence);
      if (sequence <= state.latestSequence) {
        return "ignore";
      }
      if (!state.bootstrapped || state.inFlight) {
        state.pendingReplay = true;
        return "defer";
      }
      if (sequence !== state.latestSequence + 1) {
        state.pendingReplay = true;
        return "recover";
      }
      return "apply";
    },

    markEventBatchApplied<T extends SequencedEvent>(events: ReadonlyArray<T>): ReadonlyArray<T> {
      const nextEvents = events
        .filter((event) => event.sequence > state.latestSequence)
        .toSorted((left, right) => left.sequence - right.sequence);
      if (nextEvents.length === 0) {
        return [];
      }

      state.latestSequence = nextEvents.at(-1)?.sequence ?? state.latestSequence;
      state.highestObservedSequence = Math.max(state.highestObservedSequence, state.latestSequence);
      return nextEvents;
    },

    beginSnapshotRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (state.inFlight?.kind === "snapshot") {
        state.pendingReplay = true;
        return false;
      }
      if (state.inFlight?.kind === "replay") {
        state.pendingReplay = true;
        return false;
      }
      state.inFlight = { kind: "snapshot", reason };
      return true;
    },

    completeSnapshotRecovery(snapshotSequence: number): boolean {
      state.latestSequence = Math.max(state.latestSequence, snapshotSequence);
      state.highestObservedSequence = Math.max(state.highestObservedSequence, state.latestSequence);
      state.bootstrapped = true;
      state.inFlight = null;
      return resolveReplayNeedAfterRecovery().shouldReplay;
    },

    failSnapshotRecovery(): void {
      state.inFlight = null;
    },

    beginReplayRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (!state.bootstrapped || state.inFlight?.kind === "snapshot") {
        state.pendingReplay = true;
        return false;
      }
      if (state.inFlight?.kind === "replay") {
        state.pendingReplay = true;
        return false;
      }
      state.pendingReplay = false;
      replayStartSequence = state.latestSequence;
      state.inFlight = { kind: "replay", reason };
      return true;
    },

    completeReplayRecovery(): ReplayRecoveryCompletion {
      const replayMadeProgress =
        replayStartSequence !== null && state.latestSequence > replayStartSequence;
      replayStartSequence = null;
      state.inFlight = null;
      const replayResolution = resolveReplayNeedAfterRecovery();
      return {
        replayMadeProgress,
        shouldReplay: replayResolution.shouldReplay,
      };
    },

    failReplayRecovery(): void {
      replayStartSequence = null;
      state.bootstrapped = false;
      state.inFlight = null;
    },
  };
}
