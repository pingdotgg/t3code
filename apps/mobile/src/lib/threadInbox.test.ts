import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSettleThread,
  canSnoozeThread,
  hasQueuedTurnStart,
  isThreadOutOfInbox,
  isThreadSettled,
  isThreadSnoozed,
  resolveThreadListPrimaryAction,
  settledTimestamp,
  sortSettledThreads,
  threadLastActivityAt,
  threadRaisedHandWhileSnoozed,
  THREAD_AUTO_SETTLE_AFTER_DAYS,
} from "./threadInbox";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

function makeThread(input: {
  readonly id?: string;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly activityAt?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly sessionStatus?: "starting" | "running" | "error";
  readonly sessionUpdatedAt?: string;
  readonly pending?: "approval" | "user-input";
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly turnCompletedAt?: string | null;
}): EnvironmentThreadShell {
  const threadId = ThreadId.make(input.id ?? "thread-1");
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn:
      (input.activityAt === null || input.activityAt === undefined) &&
      input.turnCompletedAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt ?? input.turnCompletedAt ?? NOW,
            startedAt: null,
            completedAt: input.turnCompletedAt ?? null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt:
      input.settledAt !== undefined
        ? input.settledAt
        : input.settledOverride === "settled"
          ? NOW
          : null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: input.sessionUpdatedAt ?? NOW,
          },
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
    autoReviewPhase: null,
  };
}

describe("threadLastActivityAt", () => {
  it("returns the latest real user or turn activity and ignores updatedAt", () => {
    const thread = makeThread({ activityAt: null });
    const withActivity: EnvironmentThreadShell = {
      ...thread,
      latestUserMessageAt: "2026-04-04T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-03T00:00:00.000Z",
        startedAt: "2026-04-05T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:00.000Z",
        assistantMessageId: null,
      },
    };

    expect(threadLastActivityAt(withActivity)).toBe("2026-04-06T00:00:00.000Z");
    expect(threadLastActivityAt(thread)).toBeNull();
  });
});

describe("hasQueuedTurnStart", () => {
  it("detects an unadopted user message inside the grace window", () => {
    const thread = makeThread({ latestUserMessageAt: "2026-04-09T23:59:30.000Z" });
    expect(hasQueuedTurnStart(thread, NOW)).toBe(true);
  });

  it("treats an unadopted message past the grace window as a failed start", () => {
    const thread = makeThread({ latestUserMessageAt: "2026-04-09T00:00:00.000Z" });
    expect(hasQueuedTurnStart(thread, NOW)).toBe(false);
  });

  it("clears once a turn has adopted the message", () => {
    const messageAt = "2026-04-09T23:59:30.000Z";
    const thread = makeThread({ activityAt: messageAt, latestUserMessageAt: messageAt });
    expect(hasQueuedTurnStart(thread, NOW)).toBe(false);
  });

  it("clears on a failed session start", () => {
    const thread = makeThread({
      latestUserMessageAt: "2026-04-09T23:59:30.000Z",
      sessionStatus: "error",
    });
    expect(hasQueuedTurnStart(thread, NOW)).toBe(false);
  });
});

describe("canSettleThread", () => {
  it("allows settling a quiescent thread", () => {
    expect(canSettleThread(makeThread({ activityAt: FRESH }), NOW)).toBe(true);
  });

  it("refuses threads blocked on approvals, user input, or a live session", () => {
    expect(canSettleThread(makeThread({ pending: "approval" }), NOW)).toBe(false);
    expect(canSettleThread(makeThread({ pending: "user-input" }), NOW)).toBe(false);
    expect(canSettleThread(makeThread({ sessionStatus: "running" }), NOW)).toBe(false);
    expect(canSettleThread(makeThread({ sessionStatus: "starting" }), NOW)).toBe(false);
  });

  it("refuses a thread with a queued turn start", () => {
    const thread = makeThread({ latestUserMessageAt: "2026-04-09T23:59:30.000Z" });
    expect(canSettleThread(thread, NOW)).toBe(false);
  });
});

describe("isThreadSettled", () => {
  it("honors the explicit override in both directions", () => {
    expect(
      isThreadSettled(makeThread({ settledOverride: "settled", activityAt: FRESH }), NOW),
    ).toBe(true);
    expect(isThreadSettled(makeThread({ settledOverride: "active", activityAt: STALE }), NOW)).toBe(
      false,
    );
  });

  it(`auto-settles after ${THREAD_AUTO_SETTLE_AFTER_DAYS} days of inactivity without an override`, () => {
    expect(isThreadSettled(makeThread({ activityAt: STALE }), NOW)).toBe(true);
    expect(isThreadSettled(makeThread({ activityAt: FRESH }), NOW)).toBe(false);
    expect(isThreadSettled(makeThread({ activityAt: null }), NOW)).toBe(false);
  });

  it("keeps blocked work visible even with a settled override", () => {
    expect(
      isThreadSettled(makeThread({ settledOverride: "settled", pending: "approval" }), NOW),
    ).toBe(false);
    expect(
      isThreadSettled(makeThread({ settledOverride: "settled", pending: "user-input" }), NOW),
    ).toBe(false);
    expect(
      isThreadSettled(makeThread({ settledOverride: "settled", sessionStatus: "running" }), NOW),
    ).toBe(false);
  });

  it("blocks on a queued turn start unless the server adjudicated the settle", () => {
    const queuedMessageAt = "2026-04-09T23:59:30.000Z";
    // Settled BEFORE the queued message: genuinely new work keeps the block.
    expect(
      isThreadSettled(
        makeThread({
          settledOverride: "settled",
          settledAt: "2026-04-09T00:00:00.000Z",
          latestUserMessageAt: queuedMessageAt,
        }),
        NOW,
      ),
    ).toBe(false);
    // Settled AFTER the queued message: the server accepted the settle with
    // the message known, so the clock-derived blocker is forgiven.
    expect(
      isThreadSettled(
        makeThread({
          settledOverride: "settled",
          settledAt: "2026-04-10T00:00:00.000Z",
          latestUserMessageAt: queuedMessageAt,
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("settledTimestamp / sortSettledThreads", () => {
  it("prefers settledAt, then last activity, then updatedAt", () => {
    const settled = makeThread({ settledOverride: "settled", settledAt: FRESH, activityAt: STALE });
    expect(settledTimestamp(settled)).toBe(FRESH);
    expect(settledTimestamp(makeThread({ activityAt: STALE }))).toBe(STALE);
    expect(settledTimestamp(makeThread({ activityAt: null }))).toBe(NOW);
  });

  it("sorts most recently settled first with id tiebreak", () => {
    const older = makeThread({
      id: "thread-b",
      settledOverride: "settled",
      settledAt: "2026-04-08T00:00:00.000Z",
    });
    const newer = makeThread({
      id: "thread-a",
      settledOverride: "settled",
      settledAt: "2026-04-09T00:00:00.000Z",
    });
    const tied = makeThread({
      id: "thread-c",
      settledOverride: "settled",
      settledAt: "2026-04-09T00:00:00.000Z",
    });

    expect(sortSettledThreads([older, tied, newer]).map((thread) => thread.id)).toEqual([
      "thread-a",
      "thread-c",
      "thread-b",
    ]);
  });
});

describe("resolveThreadListPrimaryAction", () => {
  it("offers unsettle for settled threads", () => {
    expect(resolveThreadListPrimaryAction(makeThread({ settledOverride: "settled" }), NOW)).toBe(
      "unsettle",
    );
  });

  it("offers settle for settleable active threads", () => {
    expect(resolveThreadListPrimaryAction(makeThread({ activityAt: FRESH }), NOW)).toBe("settle");
  });

  it("keeps archive for threads the inbox semantics refuse to settle", () => {
    expect(resolveThreadListPrimaryAction(makeThread({ sessionStatus: "running" }), NOW)).toBe(
      "archive",
    );
    expect(resolveThreadListPrimaryAction(makeThread({ pending: "approval" }), NOW)).toBe(
      "archive",
    );
  });
});

const FUTURE_WAKE = "2026-04-12T00:00:00.000Z";
const PAST_WAKE = "2026-04-09T00:00:00.000Z";

describe("threadRaisedHandWhileSnoozed", () => {
  it("raises on a pending approval or user-input request", () => {
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH, pending: "approval" }),
      ),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH, pending: "user-input" }),
      ),
    ).toBe(true);
  });

  it("raises on a fresh session error but not one that predates the snooze", () => {
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({
          snoozedUntil: FUTURE_WAKE,
          snoozedAt: FRESH,
          sessionStatus: "error",
          sessionUpdatedAt: NOW,
        }),
      ),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({
          snoozedUntil: FUTURE_WAKE,
          snoozedAt: NOW,
          sessionStatus: "error",
          sessionUpdatedAt: FRESH,
        }),
      ),
    ).toBe(false);
  });

  it("raises when a turn completes after the snooze was set", () => {
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH, turnCompletedAt: NOW }),
      ),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: NOW, turnCompletedAt: FRESH }),
      ),
    ).toBe(false);
  });

  it("stays false for a plain, undisturbed snooze", () => {
    expect(
      threadRaisedHandWhileSnoozed(makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH })),
    ).toBe(false);
  });
});

describe("isThreadSnoozed", () => {
  it("is suppressed while the wake time is in the future", () => {
    expect(isThreadSnoozed(makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH }), NOW)).toBe(
      true,
    );
  });

  it("reappears once the wake time has passed, with no event required", () => {
    expect(isThreadSnoozed(makeThread({ snoozedUntil: PAST_WAKE, snoozedAt: STALE }), NOW)).toBe(
      false,
    );
  });

  it("is false with no snoozedUntil, or malformed data", () => {
    expect(isThreadSnoozed(makeThread({}), NOW)).toBe(false);
    expect(isThreadSnoozed(makeThread({ snoozedUntil: "not-a-date" }), NOW)).toBe(false);
  });

  it("is false once the thread has raised its hand, even before the wake time", () => {
    expect(
      isThreadSnoozed(
        makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH, pending: "approval" }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("canSnoozeThread", () => {
  it("allows snoozing a quiescent or even a running thread", () => {
    expect(canSnoozeThread(makeThread({ activityAt: FRESH }), NOW)).toBe(true);
    expect(canSnoozeThread(makeThread({ sessionStatus: "running" }), NOW)).toBe(true);
  });

  it("refuses threads blocked on approvals, user input, or a queued turn start", () => {
    expect(canSnoozeThread(makeThread({ pending: "approval" }), NOW)).toBe(false);
    expect(canSnoozeThread(makeThread({ pending: "user-input" }), NOW)).toBe(false);
    expect(
      canSnoozeThread(makeThread({ latestUserMessageAt: "2026-04-09T23:59:30.000Z" }), NOW),
    ).toBe(false);
  });
});

describe("isThreadOutOfInbox", () => {
  it("is true for a settled thread", () => {
    expect(isThreadOutOfInbox(makeThread({ settledOverride: "settled" }), NOW)).toBe(true);
  });

  it("is true for a snoozed thread", () => {
    expect(
      isThreadOutOfInbox(makeThread({ snoozedUntil: FUTURE_WAKE, snoozedAt: FRESH }), NOW),
    ).toBe(true);
  });

  it("is false once a snooze wakes, mirroring isThreadSnoozed", () => {
    expect(isThreadOutOfInbox(makeThread({ snoozedUntil: PAST_WAKE, snoozedAt: STALE }), NOW)).toBe(
      false,
    );
  });

  it("is false for an ordinary active thread", () => {
    expect(isThreadOutOfInbox(makeThread({ activityAt: FRESH }), NOW)).toBe(false);
  });
});
