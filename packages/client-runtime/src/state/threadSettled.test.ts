import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canSettle, hasQueuedTurnStart } from "./threadSettled.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";

function makeShell(input: {
  readonly settledOverride?: "settled" | "active" | null;
  readonly activityAt: string | null;
  readonly sessionStatus?: "starting" | "running";
  readonly pending?: "approval" | "user-input";
}): OrchestrationThreadShell {
  const threadId = ThreadId.make("thread-1");
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.activityAt === null
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
    settledAt: input.settledOverride === "settled" ? NOW : null,
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
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
  };
}

describe("hasQueuedTurnStart", () => {
  const QUEUED_AT = "2026-04-09T12:00:00.000Z";
  // Within the adoption grace window of the queued message.
  const JUST_AFTER = { now: "2026-04-09T12:00:30.000Z" };

  it("flags a user message no turn has picked up, within the grace window", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, JUST_AFTER)).toBe(true);

    const staleTurn = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(staleTurn, JUST_AFTER)).toBe(true);
  });

  it("expires after the grace window: an unadopted message is a failed start, not queued work", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, { now: "2026-04-09T12:03:00.000Z" })).toBe(false);
    // Historical shells (e.g. from servers that never carried latestTurn)
    // must never read as queued.
    expect(hasQueuedTurnStart(noTurn, { now: NOW })).toBe(false);
  });

  it("clears once a turn adopts the message or the start fails", () => {
    const adopted = {
      ...makeShell({ activityAt: QUEUED_AT }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(adopted, JUST_AFTER)).toBe(false);

    const failed = makeShell({ activityAt: FRESH });
    const failedShell = {
      ...failed,
      latestUserMessageAt: QUEUED_AT,
      session: {
        threadId: failed.id,
        status: "error" as const,
        providerName: "Codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "boom",
        updatedAt: NOW,
      },
    };
    expect(hasQueuedTurnStart(failedShell, JUST_AFTER)).toBe(false);
  });

  it("is quiet without user messages", () => {
    expect(hasQueuedTurnStart(makeShell({ activityAt: FRESH }), JUST_AFTER)).toBe(false);
  });

  it("bounds the grace window in both directions: a future-stamped message is skew, not queued work", () => {
    // Message timestamps originate on other devices; a clock an hour ahead
    // must not hold the queued state for the whole skew.
    const skewed = {
      latestUserMessageAt: "2026-04-09T13:00:00.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(skewed, { now: "2026-04-09T12:00:00.000Z" })).toBe(false);
    // A small negative age (within the grace window) still reads as queued.
    const slightlyAhead = {
      latestUserMessageAt: "2026-04-09T12:00:30.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(slightlyAhead, { now: "2026-04-09T12:00:00.000Z" })).toBe(true);
  });
});

describe("canSettle", () => {
  it("blocks live or pending work", () => {
    expect(canSettle(makeShell({ activityAt: FRESH }), { now: NOW })).toBe(true);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "starting" }), { now: NOW }),
    ).toBe(false);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "running" }), { now: NOW }),
    ).toBe(false);
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "approval" }), { now: NOW })).toBe(
      false,
    );
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "user-input" }), { now: NOW })).toBe(
      false,
    );
  });

  it("blocks settling a queued turn start, only within the grace window", () => {
    const queued = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: "2026-04-09T12:00:00.000Z",
    };
    const justAfter = "2026-04-09T12:00:30.000Z";
    expect(canSettle(queued, { now: justAfter })).toBe(false);
    // Past the window the message is a failed/stale start: settleable again.
    expect(canSettle(queued, { now: NOW })).toBe(true);
  });
});
