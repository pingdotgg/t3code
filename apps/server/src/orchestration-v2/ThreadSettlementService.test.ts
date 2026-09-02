import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import {
  isAutoSettlementCandidate,
  QUEUED_TURN_START_GRACE_MS,
  shouldAutoSettleThread,
  threadHasQueuedTurnStart,
} from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

describe("isAutoSettlementCandidate", () => {
  it("excludes overridden, pinned, blocked, and working threads", () => {
    expect(isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ settledOverride: "settled" }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ settledOverride: "active" }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ activityRunStatus: "running" }), NOW_MS)).toBe(false);
    expect(
      isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: { kind: "approval" } as never,
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ label: "task" }] as never }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("keeps snoozed threads parked until they wake early on error or completion", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ ...snoozed, status: "failed" }), NOW_MS)).toBe(true);
    expect(
      isAutoSettlementCandidate(
        shell({ ...snoozed, latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    // Expired snooze is no longer a park.
    expect(isAutoSettlementCandidate(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS)).toBe(
      true,
    );
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      threadHasQueuedTurnStart(
        shell({
          latestUserMessageAt: at(-1_000),
          latestRunId: "run-1" as never,
          latestRunRequestedAt: at(-500),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    // Outside the grace window the stale message no longer blocks.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("shouldAutoSettleThread", () => {
  it("settles inactive threads once the window elapses", () => {
    const idle = shell({ latestUserMessageAt: at(-3 * DAY_MS) });
    expect(
      shouldAutoSettleThread({
        thread: idle,
        pullRequest: null,
        nowMs: NOW_MS,
        autoSettleAfterDays: 2,
        autoSettleOnMerge: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoSettleThread({
        thread: idle,
        pullRequest: null,
        nowMs: NOW_MS,
        autoSettleAfterDays: 5,
        autoSettleOnMerge: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoSettleThread({
        thread: idle,
        pullRequest: null,
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBe(false);
  });

  it("settles on merge only after the pull request outdates the user's last action", () => {
    const thread = shell({ latestUserMessageAt: at(-2 * 60 * 60 * 1_000) });
    const mergedAfter = {
      state: "merged" as const,
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - 60 * 60 * 1_000)),
    };
    const mergedBefore = {
      state: "merged" as const,
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - 3 * 60 * 60 * 1_000)),
    };
    expect(
      shouldAutoSettleThread({
        thread,
        pullRequest: mergedAfter,
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoSettleThread({
        thread,
        pullRequest: mergedAfter,
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: false,
      }),
    ).toBe(false);
    // The user acted after the merge: their engagement wins.
    expect(
      shouldAutoSettleThread({
        thread,
        pullRequest: mergedBefore,
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBe(false);
  });

  it("keeps threads with an open pull request active regardless of inactivity", () => {
    const stale = shell({ latestUserMessageAt: at(-30 * DAY_MS) });
    expect(
      shouldAutoSettleThread({
        thread: stale,
        pullRequest: { state: "open", updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MS)) },
        nowMs: NOW_MS,
        autoSettleAfterDays: 2,
        autoSettleOnMerge: true,
      }),
    ).toBe(false);
  });
});
