// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const SNOOZED_AT = "2026-04-10T09:00:00.000Z";
const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";
const PAST_WAKE = "2026-04-10T10:00:00.000Z";

function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function makeShell(input: {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly sessionStatus?: "starting" | "running" | "ready" | "error";
  readonly runtimeStatus?: string;
  readonly runtimeUpdatedAt?: string;
  readonly pending?: "approval" | "user-input";
  readonly turnCompletedAt?: string | null;
}): ThreadSnoozeShell {
  const threadId = ThreadId.make("thread-1");
  return {
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? SNOOZED_AT : null),
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    runtime:
      input.runtimeStatus === undefined
        ? null
        : {
            threadId,
            status: input.runtimeStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: input.runtimeUpdatedAt ?? "2026-04-10T12:00:00.000Z",
          },
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionStatus === "error" ? "boom" : null,
            updatedAt: "2026-04-10T11:00:00.000Z",
          },
    latestTurn:
      input.turnCompletedAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: SNOOZED_AT,
            startedAt: null,
            completedAt: input.turnCompletedAt,
            assistantMessageId: null,
          },
  };
}

type QueuedTurnShell = Parameters<typeof hasQueuedTurnStart>[0];

function makeQueuedTurnShell(overrides: Partial<QueuedTurnShell> = {}): QueuedTurnShell {
  return { latestUserMessageAt: null, latestTurn: null, session: null, ...overrides };
}

describe("effectiveSnoozed", () => {
  it("hides a thread whose wake time is in the future", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE }), { now: NOW })).toBe(true);
  });

  it("stops classifying as snoozed once the wake time passes (timer wake, no event)", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(false);
  });

  it("never snoozes a thread with no snooze state", () => {
    expect(effectiveSnoozed(makeShell({}), { now: NOW })).toBe(false);
  });

  it("never hides on malformed wake data", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: "not-a-date" }), { now: NOW })).toBe(false);
  });

  it("wakes early when the agent is blocked on the user", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "approval" }), {
        now: NOW,
      }),
    ).toBe(false);
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "user-input" }), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("wakes early on a failure that happened after the snooze", () => {
    // makeShell stamps session.updatedAt at 11:00, after SNOOZED_AT (9:00).
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("stays snoozed when the failure predates the snooze — the user saw it", () => {
    expect(
      effectiveSnoozed(
        makeShell({
          snoozedUntil: FUTURE_WAKE,
          sessionStatus: "error",
          // Snoozed AFTER the error's status edge.
          snoozedAt: "2026-04-10T11:30:00.000Z",
        }),
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("stays snoozed while the session keeps working — snooze never pauses the agent", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "running" }), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("wakes early when a run completes after the snooze was set", () => {
    expect(
      effectiveSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T10:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("ignores runs that completed before the snooze — the user saw that result", () => {
    expect(
      effectiveSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T08:00:00.000Z" }),
        { now: NOW },
      ),
    ).toBe(true);
  });
});

describe("threadRaisedHandWhileSnoozed", () => {
  it("is false for a quiet snoozed thread", () => {
    expect(threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE }))).toBe(false);
  });

  it("is true for approvals, input, and failures", () => {
    expect(
      threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "approval" })),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "user-input" })),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }),
      ),
    ).toBe(true);
  });
});

describe("effectiveSnoozed with production runtime shells", () => {
  /** Production-shaped shell for a usage-limited thread snoozed until reset. */
  function productionShell(overrides: {
    readonly runtimeUpdatedAt: string;
    readonly runCompletedAt: string | null;
    /** Stored server-row completion; latestRun.completedAt may be synthesized. */
    readonly storedRunCompletedAt?: string | null;
    readonly snoozedAt?: string | null;
    /** Latest run / runtime status; defaults to a failed usage-limit run. */
    readonly runStatus?: string;
    readonly runtimeStatus?: string;
  }): ThreadSnoozeShell {
    return {
      snoozedUntil: FUTURE_WAKE,
      // Snoozed at 09:00, after the usage-limit failure.
      snoozedAt: overrides.snoozedAt === undefined ? SNOOZED_AT : overrides.snoozedAt,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      ...(overrides.storedRunCompletedAt === undefined
        ? {}
        : { source: { latestRunCompletedAt: overrides.storedRunCompletedAt } }),
      runtime: {
        threadId: ThreadId.make("thread-1"),
        status: overrides.runtimeStatus ?? "failed",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "boom",
        updatedAt: overrides.runtimeUpdatedAt,
      },
      latestRun: {
        turnId: TurnId.make("turn-1"),
        status: overrides.runStatus ?? "failed",
        requestedAt: "2026-04-10T07:00:00.000Z",
        startedAt: null,
        completedAt: overrides.runCompletedAt,
      },
    };
  }

  it("stays snoozed when unrelated activity bumps runtime.updatedAt after a limit snooze", () => {
    // A usage-limited thread snoozed until reset: failure at 08:00, snoozed at
    // 09:00. A later title/metadata update bumps runtime.updatedAt
    // (projection activity time) to 11:00 without any new failure. The thread
    // must stay snoozed until the reset time.
    expect(
      effectiveSnoozed(
        productionShell({
          runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
          runCompletedAt: "2026-04-10T08:00:00.000Z",
        }),
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("wakes when a run fails after the snooze was set", () => {
    const shell = productionShell({
      runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
      runCompletedAt: "2026-04-10T10:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadRaisedHandWhileSnoozed(shell)).toBe(true);
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T10:30:00.000Z");
  });

  it("ignores a completedAt synthesized from activity time when the stored completion predates the snooze", () => {
    // Older servers omit the stored completion, so presentation synthesizes
    // latestRun.completedAt from projection activity time (11:00 here). The
    // stored completion (08:00, before the 09:00 snooze) is authoritative:
    // the thread must stay snoozed.
    const shell = productionShell({
      runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
      runCompletedAt: "2026-04-10T11:00:00.000Z",
      storedRunCompletedAt: "2026-04-10T08:00:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
    expect(threadRaisedHandWhileSnoozed(shell)).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe(null);
  });

  it("reports the stored completion when it is the fresh outcome", () => {
    const shell = productionShell({
      runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
      runCompletedAt: "2026-04-10T11:00:00.000Z",
      storedRunCompletedAt: "2026-04-10T10:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T10:30:00.000Z");
  });

  it("treats a null stored completion as no confirmed completion", () => {
    // Server row carried but no stored completion: the later
    // latestRun.completedAt is synthesized from activity time, so it must not
    // wake the thread.
    const shell = productionShell({
      runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
      runCompletedAt: "2026-04-10T11:00:00.000Z",
      storedRunCompletedAt: null,
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
    expect(threadRaisedHandWhileSnoozed(shell)).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe(null);
  });

  it("wakes a failed thread that has no snooze anchor", () => {
    const shell = productionShell({
      runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
      runCompletedAt: "2026-04-10T08:00:00.000Z",
      snoozedAt: null,
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadRaisedHandWhileSnoozed(shell)).toBe(true);
  });

  it.each(["cancelled", "interrupted", "rolled_back"])(
    "wakes when a %s run ends after the snooze",
    (runStatus) => {
      // Any terminal outcome with a fresh completion wakes the thread, matching
      // the server's latestRunCompletedAt comparison (no status gate).
      const shell = productionShell({
        runtimeStatus: runStatus,
        runStatus,
        runtimeUpdatedAt: "2026-04-10T11:00:00.000Z",
        runCompletedAt: "2026-04-10T10:30:00.000Z",
        storedRunCompletedAt: "2026-04-10T10:30:00.000Z",
      });
      expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
      expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T10:30:00.000Z");
    },
  );
});

describe("effectiveSnoozed against a presented server shell", () => {
  const environmentId = EnvironmentId.make("environment-snooze");

  /**
   * The real production wiring: a usage-limited thread snoozed until reset,
   * with the projection clock advanced by an unrelated event after the
   * snooze. `presentThreadShell` synthesizes latestRun.completedAt from that
   * clock when the server omits the stored completion, which is the exact
   * shape that used to wake the thread early.
   */
  function presentedLimitedShell(
    storedCompletedAt: string | null | undefined,
  ): EnvironmentThreadShell {
    return presentThreadShell(environmentId, {
      ...v2ThreadShell,
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: FUTURE_WAKE,
      latestRunId: RunId.make("run-snooze"),
      latestRunRequestedAt: DateTime.makeUnsafe("2026-04-10T07:00:00.000Z"),
      ...(storedCompletedAt === undefined
        ? {}
        : {
            latestRunCompletedAt:
              storedCompletedAt === null ? null : DateTime.makeUnsafe(storedCompletedAt),
          }),
      updatedAt: DateTime.makeUnsafe("2026-04-10T11:00:00.000Z"),
      snoozedUntil: DateTime.makeUnsafe(FUTURE_WAKE),
      snoozedAt: DateTime.makeUnsafe(SNOOZED_AT),
    });
  }

  it("stays snoozed when the server omits the stored completion", () => {
    const shell = presentedLimitedShell(undefined);
    // Presentation fills completedAt from the later activity time…
    expect(shell.latestRun?.completedAt).toBe("2026-04-10T11:00:00.000Z");
    // …but the snooze anchor predates it, so the thread must stay parked.
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
    expect(threadWokeAt(shell, { now: NOW })).toBe(null);
  });

  it("stays snoozed when the stored completion predates the snooze", () => {
    const shell = presentedLimitedShell("2026-04-10T08:00:00.000Z");
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
  });

  it("wakes and reports the stored completion when it follows the snooze", () => {
    const shell = presentedLimitedShell("2026-04-10T10:30:00.000Z");
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T10:30:00.000Z");
  });
});

describe("canSnooze", () => {
  it("allows snoozing quiet and working threads alike", () => {
    expect(canSnooze({ ...makeShell({}), latestUserMessageAt: null }, { now: NOW })).toBe(true);
    expect(
      canSnooze(
        { ...makeShell({ sessionStatus: "running" }), latestUserMessageAt: null },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("refuses blocked-on-you work", () => {
    expect(
      canSnooze({ ...makeShell({ pending: "approval" }), latestUserMessageAt: null }, { now: NOW }),
    ).toBe(false);
    expect(
      canSnooze(
        { ...makeShell({ pending: "user-input" }), latestUserMessageAt: null },
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("refuses a queued turn start — same invisible-pending-work rule as settle", () => {
    // Fresh user message, no turn has adopted it, within the grace window.
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:59:30.000Z" },
        { now: NOW },
      ),
    ).toBe(false);
    // Outside the grace window the message is stale data, not queued work.
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:00:00.000Z" },
        { now: NOW },
      ),
    ).toBe(true);
  });
});

describe("hasQueuedTurnStart", () => {
  it("expires queued state after two minutes", () => {
    const thread = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T11:57:59.000Z",
    });
    expect(hasQueuedTurnStart(thread, { now: NOW })).toBe(false);
  });

  it("clears queued state when a turn adopts the message or the session fails", () => {
    const messageAt = "2026-04-10T11:59:00.000Z";
    const adopted = makeQueuedTurnShell({
      latestUserMessageAt: messageAt,
      latestTurn: {
        turnId: TurnId.make("turn-adopted"),
        state: "running",
        requestedAt: messageAt,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const failed = makeQueuedTurnShell({
      latestUserMessageAt: messageAt,
      session: {
        threadId: ThreadId.make("thread-failed"),
        status: "error",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "failed",
        updatedAt: NOW,
      },
    });
    expect(hasQueuedTurnStart(adopted, { now: NOW })).toBe(false);
    expect(hasQueuedTurnStart(failed, { now: NOW })).toBe(false);
  });

  it("bounds future client clock skew", () => {
    const farAhead = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T12:03:00.000Z",
    });
    const slightlyAhead = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T12:01:00.000Z",
    });
    expect(hasQueuedTurnStart(farAhead, { now: NOW })).toBe(false);
    expect(hasQueuedTurnStart(slightlyAhead, { now: NOW })).toBe(true);
  });
});

describe("threadWokeAt", () => {
  it("is null for never-snoozed and still-snoozed threads", () => {
    expect(threadWokeAt(makeShell({}), { now: NOW })).toBe(null);
    expect(threadWokeAt(makeShell({ snoozedUntil: FUTURE_WAKE }), { now: NOW })).toBe(null);
  });

  it("reports the wake time for a timer wake", () => {
    expect(threadWokeAt(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(PAST_WAKE);
  });

  it("reports the completion time for an early run-completed wake", () => {
    expect(
      threadWokeAt(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T10:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe("2026-04-10T10:30:00.000Z");
  });

  it("falls back to session activity for blocked/failed early wakes", () => {
    expect(
      threadWokeAt(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }), {
        now: NOW,
      }),
    ).toBe("2026-04-10T11:00:00.000Z");
  });

  it("reports the session timestamp when the session caused the wake", () => {
    // Both clocks present, no fresh run outcome: the 11:00 session error woke
    // the thread, so the Woke indicator must not report the 12:00 runtime
    // activity time.
    expect(
      threadWokeAt(
        makeShell({
          snoozedUntil: FUTURE_WAKE,
          sessionStatus: "error",
          runtimeStatus: "failed",
          runtimeUpdatedAt: "2026-04-10T12:00:00.000Z",
        }),
        { now: NOW },
      ),
    ).toBe("2026-04-10T11:00:00.000Z");
  });

  it("keeps the early wake authoritative after the scheduled time passes", () => {
    // Woke early at 10:30 via run-completed; the scheduled wake (PAST_WAKE
    // 10:00 relative to a later now) has ALSO passed. Reporting the
    // scheduled time would resurface a Woke pill the user already cleared
    // by visiting between the early wake and now.
    expect(
      threadWokeAt(
        makeShell({ snoozedUntil: PAST_WAKE, turnCompletedAt: "2026-04-10T09:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe("2026-04-10T09:30:00.000Z");
  });
});

describe("snoozeWakeLabel", () => {
  const now = "2026-06-02T00:00:00.000Z";

  it("formats remaining time coarsely, rounding up", () => {
    expect(snoozeWakeLabel("2026-06-02T00:30:00.000Z", { now })).toBe("30m");
    expect(snoozeWakeLabel("2026-06-02T01:30:00.000Z", { now })).toBe("2h");
    expect(snoozeWakeLabel("2026-06-03T02:00:00.000Z", { now })).toBe("2d");
  });

  it("never reads zero or negative while still snoozed", () => {
    expect(snoozeWakeLabel("2026-06-02T00:00:30.000Z", { now })).toBe("1m");
    expect(snoozeWakeLabel("2026-06-01T23:59:59.000Z", { now })).toBe("now");
    expect(snoozeWakeLabel("not-a-date", { now })).toBe("now");
    expect(snoozeWakeLabel("2026-06-02T09:00:00.000Z", { now: "bad" })).toBe("now");
  });
});

describe("resolveSnoozePresets", () => {
  it("offers the shared desktop and mobile choices", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets.find((preset) => preset.id === "three-hours")?.snoozedUntil).toBe(
      localDate(2026, 4, 8, 13).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "three-hours")?.label).toBe("In 3 hours");
    expect(presets.find((preset) => preset.id === "evening")?.label).toBe("This evening");
    expect(
      new Date(presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil).getHours(),
    ).toBe(9);
  });

  it("drops the evening choice once evening is near or past", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("puts next week on the following Monday", () => {
    const nextWeek = new Date(
      resolveSnoozePresets(localDate(2026, 4, 6, 10)).find((preset) => preset.id === "next-week")!
        .snoozedUntil,
    );
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });

  it("drops next week on Sundays, when it lands on the same Monday as tomorrow", () => {
    // Sunday 2026-08-30 07:01: "Tomorrow" and "Next week" are both Monday 9:00.
    const presets = resolveSnoozePresets(localDate(2026, 8, 30, 7, 1));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
    ]);
    const tomorrow = new Date(presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil);
    expect(tomorrow.getDay()).toBe(1);
  });
});
