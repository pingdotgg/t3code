import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ThreadId, ProjectId, OrchestrationEvent, TurnId } from "@marcode/contracts";
import {
  BUILT_IN_SOUNDS,
  reasonToEventGroup,
  buildNotificationContent,
  deriveTurnNotificationTriggers,
  getLocallyInterruptedTurnsSnapshot,
  isTurnLocallyInterrupted,
  markThreadUserStopped,
  markTurnLocallyInterrupted,
  subscribeToLocallyInterruptedTurns,
  __resetTurnNotificationStateForTests,
} from "./turnNotification";
import type { Thread, Project } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as ThreadId,
    title: "Test thread",
    projectId: "project-1" as ProjectId,
    session: { orchestrationStatus: "running" },
    ...overrides,
  } as Thread;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1" as ProjectId,
    name: "Test project",
    ...overrides,
  } as Project;
}

function makeSessionSetEvent(
  threadId: string,
  status: string,
  extraSession: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    type: "thread.session-set",
    payload: {
      threadId: threadId as ThreadId,
      session: { status, ...extraSession },
    },
  } as unknown as OrchestrationEvent;
}

function makeActivityAppendedEvent(threadId: string, kind: string): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    payload: {
      threadId: threadId as ThreadId,
      activity: { kind },
    },
  } as unknown as OrchestrationEvent;
}

function makeTurnDiffCompletedEvent(threadId: string): OrchestrationEvent {
  return {
    type: "thread.turn-diff-completed",
    payload: {
      threadId: threadId as ThreadId,
      turnId: `turn-${threadId}`,
    },
  } as unknown as OrchestrationEvent;
}

describe("BUILT_IN_SOUNDS", () => {
  it("has 4 entries with valid id, label, and src", () => {
    expect(BUILT_IN_SOUNDS).toHaveLength(4);
    for (const sound of BUILT_IN_SOUNDS) {
      expect(sound.id).toBeTruthy();
      expect(sound.label).toBeTruthy();
      expect(sound.src).toMatch(/^\/sounds\/.+\.mp3$/);
    }
  });
});

describe("reasonToEventGroup", () => {
  it("maps turn-completed to turn-events", () => {
    expect(reasonToEventGroup("turn-completed")).toBe("turn-events");
  });

  it("maps approval-requested to approval-needed", () => {
    expect(reasonToEventGroup("approval-requested")).toBe("approval-needed");
  });
});

describe("buildNotificationContent", () => {
  it("formats title and body correctly", () => {
    const result = buildNotificationContent({
      threadId: "thread-1" as ThreadId,
      reason: "turn-completed",
      threadTitle: "My thread",
      projectName: "My project",
    });
    expect(result.title).toBe("Turn completed");
    expect(result.body).toBe('"My thread" \u2014 My project');
  });
});

describe("deriveTurnNotificationTriggers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTurnNotificationStateForTests();
  });

  it("emits trigger for a completed turn", () => {
    const thread = makeThread();
    const project = makeProject();
    // Arm the persistent active-turn flag with a prior running event.
    deriveTurnNotificationTriggers(
      [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-1" })],
      () => thread,
      () => project,
    );

    const events = [makeSessionSetEvent("thread-1", "idle")];
    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe("turn-completed");
    expect(triggers[0]!.threadTitle).toBe("Test thread");
    expect(triggers[0]!.projectName).toBe("Test project");
  });

  it("suppresses user-stopped threads", () => {
    const thread = makeThread();
    const project = makeProject();

    vi.spyOn(Date, "now").mockReturnValue(1000);
    markThreadUserStopped("thread-1" as ThreadId);

    vi.spyOn(Date, "now").mockReturnValue(2000);
    const events = [makeSessionSetEvent("thread-1", "idle")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(0);
  });

  it("emits for approval-requested activity", () => {
    const thread = makeThread();
    const project = makeProject();
    const events = [makeActivityAppendedEvent("thread-1", "approval.requested")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe("approval-requested");
  });

  it("markThreadUserStopped suppresses subsequent triggers within window", () => {
    const thread = makeThread({ id: "thread-2" as ThreadId });
    const project = makeProject();

    // Arm the flag so the strict gate lets completion events through.
    deriveTurnNotificationTriggers(
      [makeSessionSetEvent("thread-2", "running", { activeTurnId: "turn-1" })],
      () => thread,
      () => project,
    );

    vi.spyOn(Date, "now").mockReturnValue(10000);
    markThreadUserStopped("thread-2" as ThreadId);

    vi.spyOn(Date, "now").mockReturnValue(13000);
    const eventsWithinWindow = [makeSessionSetEvent("thread-2", "ready")];

    const triggersWithin = deriveTurnNotificationTriggers(
      eventsWithinWindow,
      () => thread,
      () => project,
    );
    expect(triggersWithin).toHaveLength(0);

    // Re-arm for the post-window event (suppression doesn't clear the flag
    // but a successful fire would — so we re-arm here to simulate the next
    // turn's running transition that normally preceeds the completion).
    deriveTurnNotificationTriggers(
      [makeSessionSetEvent("thread-2", "running", { activeTurnId: "turn-2" })],
      () => thread,
      () => project,
    );

    vi.spyOn(Date, "now").mockReturnValue(16000);
    const eventsAfterWindow = [makeSessionSetEvent("thread-2", "idle")];

    const triggersAfter = deriveTurnNotificationTriggers(
      eventsAfterWindow,
      () => thread,
      () => project,
    );
    expect(triggersAfter).toHaveLength(1);
    expect(triggersAfter[0]!.reason).toBe("turn-completed");
  });

  it("fires turn-completed when a session.set for running arrives earlier in the same batch", () => {
    // Reconnect / replay: both the turn.started -> "running" and the
    // turn.completed -> "ready" session-set events land together. getThread
    // reports the pre-batch state (stopped/ready/idle), so the completion
    // must still fire because we observed the running transition in-batch.
    const thread = makeThread({
      session: { orchestrationStatus: "stopped" },
    } as Partial<Thread>);
    const project = makeProject();
    const events = [
      makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-batch-1" }),
      makeSessionSetEvent("thread-1", "ready"),
    ];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe("turn-completed");
  });

  it("does NOT fire turn-completed from stored latestTurn alone without an observed running event", () => {
    // The strict gate requires a `thread.session-set` with status=running to
    // have been observed (in any batch) before completion will fire. Stored
    // state alone — even when it looks like a turn is active — is no longer
    // sufficient, because that stored state can be stale or delivered via the
    // shell stream for a bootstrap session that never actually ran a turn.
    const thread = makeThread({
      session: { orchestrationStatus: "ready" },
      latestTurn: { state: "running", turnId: "turn-1" },
    } as Partial<Thread>);
    const project = makeProject();
    const events = [makeSessionSetEvent("thread-1", "idle")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(0);
  });

  it("does NOT fire turn-completed from stored activeTurnId alone without an observed running event", () => {
    // Same rationale as the latestTurn case: the persistent arm must be set
    // from a `thread.session-set` running event. An activeTurnId snapshotted
    // from the shell stream is not enough on its own.
    const thread = makeThread({
      session: { orchestrationStatus: "ready", activeTurnId: "turn-1" },
    } as Partial<Thread>);
    const project = makeProject();
    const events = [makeSessionSetEvent("thread-1", "ready")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(0);
  });

  it("skips turn-completed when the thread never saw a running turn", () => {
    // No running status, no active turn, no running transition in-batch.
    // The completion event is for a session that never actually ran — typical
    // for provider bootstrap or idle state seeding — so no notification fires.
    const thread = makeThread({
      session: { orchestrationStatus: "ready" },
    } as Partial<Thread>);
    const project = makeProject();
    const events = [makeSessionSetEvent("thread-1", "ready")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(0);
  });

  it("falls back to turn-diff-completed when session-set signal is missing", () => {
    // The session-set path can be lost (subscription race, snapshot overwrite)
    // but the CheckpointReactor reliably dispatches thread.turn-diff-completed
    // after an actual turn.completed runtime event, so the user still gets
    // notified — as long as we saw a running transition earlier (strict gate).
    const thread = makeThread({
      session: { orchestrationStatus: "ready" },
    } as Partial<Thread>);
    const project = makeProject();
    // Arm the flag as a prior running transition would.
    deriveTurnNotificationTriggers(
      [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-1" })],
      () => thread,
      () => project,
    );

    const events = [makeTurnDiffCompletedEvent("thread-1")];
    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe("turn-completed");
  });

  it("dedupes session-set + turn-diff-completed for the same thread", () => {
    // Both the primary session-set signal and the turn-diff-completed fallback
    // arrive together in the happy path. Only one notification should fire.
    const thread = makeThread({
      session: { orchestrationStatus: "running" },
    } as Partial<Thread>);
    const project = makeProject();
    // Prior batch: arm via running transition.
    deriveTurnNotificationTriggers(
      [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-1" })],
      () => thread,
      () => project,
    );
    const events = [
      makeSessionSetEvent("thread-1", "ready"),
      makeTurnDiffCompletedEvent("thread-1"),
    ];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe("turn-completed");
  });

  it("honors user-initiated stops on the turn-diff-completed fallback", () => {
    // If the user stopped the turn themselves, the fallback must respect the
    // 5-second suppression window so we don't notify for a stop they just did.
    const thread = makeThread({
      session: { orchestrationStatus: "running" },
    } as Partial<Thread>);
    const project = makeProject();

    vi.spyOn(Date, "now").mockReturnValue(1000);
    markThreadUserStopped("thread-1" as ThreadId);

    vi.spyOn(Date, "now").mockReturnValue(2000);
    const events = [makeTurnDiffCompletedEvent("thread-1")];

    const triggers = deriveTurnNotificationTriggers(
      events,
      () => thread,
      () => project,
    );

    expect(triggers).toHaveLength(0);
  });

  describe("regression: ACP (Cursor/OpenCode) thread lifecycle", () => {
    it("does NOT fire on session.started emitting status=ready with activeTurnId=null", () => {
      // Repro for Bug 1: when Cursor/OpenCode open a session, the provider
      // emits session.started → server dispatches thread.session-set with
      // status=ready and activeTurnId=null. The previous check
      // `activeTurnId !== undefined` mis-treated `null` as "has active turn"
      // and fired a spurious turn-completed notification on thread creation.
      const thread = makeThread({
        session: { orchestrationStatus: "ready", activeTurnId: null },
      } as unknown as Partial<Thread>);
      const project = makeProject();
      const events = [makeSessionSetEvent("thread-1", "ready", { activeTurnId: null })];

      const triggers = deriveTurnNotificationTriggers(
        events,
        () => thread,
        () => project,
      );

      expect(triggers).toHaveLength(0);
    });

    it("fires on follow-up turn completion even if stored session.status lags to ready", () => {
      // Repro for Bug 2: shell-stream updates can write thread.session.status
      // to "ready" before the detail-stream's thread.session-set event arrives
      // for derivation, so `orchestrationStatus === "running"` reads false.
      // The persistent threadsWithActiveTurn flag, armed by the earlier
      // running event, makes the completion fire anyway.
      const thread = makeThread({
        session: { orchestrationStatus: "ready", activeTurnId: null },
      } as unknown as Partial<Thread>);
      const project = makeProject();

      // Batch 1: running status arms the persistent flag.
      deriveTurnNotificationTriggers(
        [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-42" })],
        () => thread,
        () => project,
      );

      // Batch 2: completion arrives after shell stream raced the status to
      // "ready". No in-batch running transition and stored status no longer
      // running — but the armed flag keeps us honest.
      const triggers = deriveTurnNotificationTriggers(
        [makeSessionSetEvent("thread-1", "ready")],
        () => thread,
        () => project,
      );

      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.reason).toBe("turn-completed");
    });

    it("dedupes completion across separate batches (Bug 3: doubled sound)", () => {
      // Repro for Bug 3: applyEnvironmentThreadDetailEvent wraps each single
      // event in its own batch, so thread.session-set (ready) and
      // thread.turn-diff-completed each triggered the batch-local dedup set
      // independently, firing twice. Cross-batch dedup with a 3s TTL collapses
      // them to one sound per real turn end.
      const thread = makeThread({
        session: { orchestrationStatus: "running", activeTurnId: "turn-1" },
      } as Partial<Thread>);
      const project = makeProject();

      // Arm the persistent flag first (required by strict gate).
      deriveTurnNotificationTriggers(
        [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-1" })],
        () => thread,
        () => project,
      );
      const firstBatch = deriveTurnNotificationTriggers(
        [makeSessionSetEvent("thread-1", "ready")],
        () => thread,
        () => project,
      );
      const secondBatch = deriveTurnNotificationTriggers(
        [makeTurnDiffCompletedEvent("thread-1")],
        () => thread,
        () => project,
      );

      expect(firstBatch).toHaveLength(1);
      expect(secondBatch).toHaveLength(0);
    });

    it(
      "OpenCode first-message: session.started + thread.started + turn.started + turn.completed " +
        "fires exactly once, at the actual turn end",
      () => {
        // User-reported repro: OpenCode emits session.started → thread.started →
        // turn.started → turn.completed in separate batches for the first
        // message on a brand-new thread. The only sound that may play is at
        // turn.completed. Every earlier event MUST be silent, even when the
        // stored thread state reflects partial application.
        const project = makeProject();
        let threadState: Thread = makeThread({ session: undefined } as unknown as Partial<Thread>);

        // Batch 1: session.started → status=ready, activeTurnId=null.
        let triggers = deriveTurnNotificationTriggers(
          [makeSessionSetEvent("thread-1", "ready", { activeTurnId: null })],
          () => threadState,
          () => project,
        );
        expect(triggers).toHaveLength(0);
        threadState = makeThread({
          session: { orchestrationStatus: "ready", activeTurnId: null },
        } as unknown as Partial<Thread>);

        // Batch 2: thread.started → status=ready, activeTurnId=null.
        triggers = deriveTurnNotificationTriggers(
          [makeSessionSetEvent("thread-1", "ready", { activeTurnId: null })],
          () => threadState,
          () => project,
        );
        expect(triggers).toHaveLength(0);

        // Batch 3: turn.started → status=running, activeTurnId=T1.
        triggers = deriveTurnNotificationTriggers(
          [makeSessionSetEvent("thread-1", "running", { activeTurnId: "turn-1" })],
          () => threadState,
          () => project,
        );
        expect(triggers).toHaveLength(0);
        threadState = makeThread({
          session: { orchestrationStatus: "running", activeTurnId: "turn-1" },
        } as Partial<Thread>);

        // Batch 4: turn.completed → status=ready. Sound should fire exactly here.
        triggers = deriveTurnNotificationTriggers(
          [makeSessionSetEvent("thread-1", "ready", { activeTurnId: null })],
          () => threadState,
          () => project,
        );
        expect(triggers).toHaveLength(1);
        expect(triggers[0]!.reason).toBe("turn-completed");
      },
    );
  });
});

describe("locally interrupted turn tracker", () => {
  it("marks a turn as locally interrupted", () => {
    const turnId = "turn-interrupted-1" as TurnId;
    expect(isTurnLocallyInterrupted(turnId)).toBe(false);
    markTurnLocallyInterrupted(turnId);
    expect(isTurnLocallyInterrupted(turnId)).toBe(true);
  });

  it("keeps follow-up turns unaffected (different turnId)", () => {
    const interruptedTurn = "turn-interrupted-2" as TurnId;
    const followUpTurn = "turn-followup-2" as TurnId;
    markTurnLocallyInterrupted(interruptedTurn);
    expect(isTurnLocallyInterrupted(interruptedTurn)).toBe(true);
    // A brand-new turn id (what happens when the user sends a follow-up
    // message) must NOT inherit the interrupted flag — otherwise the in-chat
    // "Working…" indicator would stay hidden for the new turn.
    expect(isTurnLocallyInterrupted(followUpTurn)).toBe(false);
  });

  it("notifies subscribers and swaps snapshot reference on write", () => {
    const turnId = "turn-interrupted-3" as TurnId;
    const listener = vi.fn();
    const unsubscribe = subscribeToLocallyInterruptedTurns(listener);

    const before = getLocallyInterruptedTurnsSnapshot();
    markTurnLocallyInterrupted(turnId);
    const after = getLocallyInterruptedTurnsSnapshot();

    expect(listener).toHaveBeenCalledTimes(1);
    // useSyncExternalStore relies on reference equality to detect changes —
    // the snapshot set must be a new object, not the mutated original.
    expect(after).not.toBe(before);
    expect(after.has(turnId)).toBe(true);

    // Re-marking the same turn is a no-op: no listener call, same reference.
    markTurnLocallyInterrupted(turnId);
    const afterSecond = getLocallyInterruptedTurnsSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(afterSecond).toBe(after);

    unsubscribe();
  });
});
