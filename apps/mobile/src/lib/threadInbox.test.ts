import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSettleThread,
  hasQueuedTurnStart,
  isThreadSettled,
  resolveThreadListPrimaryAction,
  settledTimestamp,
  sortSettledThreads,
  threadLastActivityAt,
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
  readonly pending?: "approval" | "user-input";
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
      input.activityAt === null || input.activityAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
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
            updatedAt: NOW,
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
