// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { DEFAULT_SNOOZE_PRESETS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  isThreadWokeUnseen,
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
  readonly pending?: "approval" | "user-input";
  readonly turnRequestedAt?: string | null;
  readonly turnCompletedAt?: string | null;
}): ThreadSnoozeShell {
  const threadId = ThreadId.make("thread-1");
  return {
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? SNOOZED_AT : null),
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
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
            requestedAt: input.turnRequestedAt === undefined ? SNOOZED_AT : input.turnRequestedAt,
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

  it.each([
    {
      reason: "stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: undefined,
      wokeAt: null,
    },
    {
      reason: "fresh failure",
      completedAt: "2026-04-10T10:00:00.000Z",
      pending: undefined,
      wokeAt: "2026-04-10T10:00:00.000Z",
    },
    {
      reason: "approval after a stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: "approval",
      wokeAt: "2026-04-10T11:00:00.000Z",
    },
    {
      reason: "input after a stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: "user-input",
      wokeAt: "2026-04-10T11:00:00.000Z",
    },
  ] as const)(
    "uses the wake event time for $reason despite newer metadata",
    ({ completedAt, pending, wokeAt }) => {
      const shell: ThreadSnoozeShell = {
        ...makeShell({ snoozedUntil: FUTURE_WAKE }),
        hasPendingApprovals: pending === "approval",
        hasPendingUserInput: pending === "user-input",
        runtime: { status: "failed", updatedAt: "2026-04-10T11:00:00.000Z" },
        latestRun: { status: "failed", requestedAt: "2026-04-10T07:00:00.000Z", completedAt },
      };
      expect(effectiveSnoozed(shell, { now: NOW })).toBe(wokeAt === null);
      expect(threadWokeAt(shell, { now: NOW })).toBe(wokeAt);
    },
  );

  it("stays snoozed while the session keeps working — snooze never pauses the agent", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "running" }), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("stays snoozed when a run requested after the snooze completes", () => {
    const shell = {
      ...makeShell({ snoozedUntil: FUTURE_WAKE }),
      latestRun: {
        status: "completed",
        requestedAt: "2026-04-10T09:00:00.001Z",
        startedAt: "2026-04-10T09:15:00.000Z",
        completedAt: "2026-04-10T10:30:00.000Z",
      },
    };

    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
    expect(threadWokeAt(shell, { now: NOW })).toBe(null);
  });
});

describe("threadRaisedHandWhileSnoozed", () => {
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

describe("canSnooze", () => {
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
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: null, pendingSubagentRequest: "approval" },
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("refuses a queued turn start — same invisible-pending-work rule as settle", () => {
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:59:30.000Z" },
        { now: NOW },
      ),
    ).toBe(false);
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:00:00.000Z" },
        { now: NOW },
      ),
    ).toBe(true);
  });
});

describe("hasQueuedTurnStart", () => {
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
});

describe("threadWokeAt", () => {
  it("reports the timer wake even after an already-requested run completes", () => {
    expect(threadWokeAt(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(PAST_WAKE);
    const shell = makeShell({
      snoozedUntil: PAST_WAKE,
      turnCompletedAt: "2026-04-10T09:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe(PAST_WAKE);
  });

  it.each([
    { reason: "failure", sessionStatus: "error" },
    { reason: "approval", sessionStatus: "ready", pending: "approval" },
    { reason: "user input", sessionStatus: "ready", pending: "user-input" },
  ] as const)("reports $reason activity instead of an already-requested completion", (activity) => {
    const shell = makeShell({
      ...activity,
      snoozedUntil: FUTURE_WAKE,
      turnCompletedAt: "2026-04-10T10:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T11:00:00.000Z");
  });

  it("keeps the early wake authoritative after the scheduled time passes", () => {
    const shell: ThreadSnoozeShell = {
      ...makeShell({ snoozedUntil: PAST_WAKE }),
      runtime: { status: "failed", updatedAt: "2026-04-10T11:00:00.000Z" },
      latestRun: {
        status: "failed",
        requestedAt: "2026-04-10T09:15:00.000Z",
        completedAt: "2026-04-10T09:30:00.000Z",
      },
    };
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T09:30:00.000Z");
  });
});

describe("resolveSnoozePresets", () => {
  it("preserves the existing presets when no custom slots are saved", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 5));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets.find((preset) => preset.id === "hour")?.snoozedUntil).toBe(
      localDate(2026, 4, 6, 6).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "tomorrow")?.snoozedUntil).toBe(
      localDate(2026, 4, 7, 9).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "next-week")?.snoozedUntil).toBe(
      localDate(2026, 4, 13, 9).toISOString(),
    );
  });

  it("resolves five relative and absolute slots in their fixed order", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), [
      { mode: "relative", hours: 168 },
      { mode: "relative", hours: 3 },
      { mode: "absolute", day: "today", time: "18:00" },
      { mode: "absolute", day: "tomorrow", time: "06:00" },
      { mode: "absolute", day: "monday", time: "06:00" },
    ]);
    expect(presets.map((preset) => preset.id)).toEqual([
      "preset-0",
      "preset-1",
      "preset-2",
      "preset-3",
      "preset-4",
    ]);
    expect(presets.map((preset) => preset.snoozedUntil)).toEqual([
      localDate(2026, 4, 15, 10).toISOString(),
      localDate(2026, 4, 8, 13).toISOString(),
      localDate(2026, 4, 8, 18).toISOString(),
      localDate(2026, 4, 9, 6).toISOString(),
      localDate(2026, 4, 13, 6).toISOString(),
    ]);
    expect(presets[0]?.label).toBe("In 7 days");
    expect(presets[1]?.label).toBe("In 3 hours");
    expect(presets[2]?.label).toBe("This evening");
    expect(presets[3]?.label).toBe("Tomorrow");
    expect(presets[4]?.label).toBe("Next week");
  });

  it("preserves the original menu labels after saving the default slots", () => {
    const now = localDate(2026, 4, 8, 10);
    const defaults = resolveSnoozePresets(now);
    const configured = resolveSnoozePresets(now, DEFAULT_SNOOZE_PRESETS);
    expect(configured.map((preset) => preset.label)).toEqual(
      defaults.map((preset) => preset.label),
    );
    expect(configured.map((preset) => preset.whenLabel)).toEqual(
      defaults.map((preset) => preset.whenLabel),
    );
  });

  it.each([
    [1, "In 1 hour"],
    [3, "In 3 hours"],
    [24, "In 1 day"],
    [48, "In 2 days"],
    [25, "In 25 hours"],
    [168, "In 7 days"],
  ])("labels a relative duration of %i hours as %s", (hours, expected) => {
    const preferences = [...DEFAULT_SNOOZE_PRESETS];
    preferences[0] = { mode: "relative", hours };
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 10), preferences)[0]?.label).toBe(expected);
  });

  it.each([
    ["today", "11:00", "This morning"],
    ["today", "12:00", "This afternoon"],
    ["today", "17:59", "This afternoon"],
    ["today", "18:00", "This evening"],
    ["wednesday", "15:00", "This afternoon"],
    ["tomorrow", "06:00", "Tomorrow"],
    ["thursday", "06:00", "Tomorrow"],
    ["friday", "06:00", "Friday"],
    ["monday", "06:00", "Next week"],
    ["wednesday", "09:00", "Next week"],
  ] as const)("labels an absolute %s slot at %s as %s", (day, time, expected) => {
    const preferences = [...DEFAULT_SNOOZE_PRESETS];
    preferences[0] = { mode: "absolute", day, time };
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 10), preferences)[0]?.label).toBe(expected);
  });

  it.each([
    [10, "sunday", "Sunday"],
    [10, "saturday", "Tomorrow"],
    [12, "monday", "Tomorrow"],
    [12, "tuesday", "Next week"],
    [12, "sunday", "Next week"],
  ] as const)("uses Monday as the start of the week on April %i for %s", (date, day, expected) => {
    const preferences = [...DEFAULT_SNOOZE_PRESETS];
    preferences[0] = { mode: "absolute", day, time: "06:00" };
    expect(resolveSnoozePresets(localDate(2026, 4, date, 10), preferences)[0]?.label).toBe(
      expected,
    );
  });

  it.each([
    [5, 6],
    [6, 13],
    [7, 13],
  ])("chooses the next weekday occurrence at %i:00", (hour, day) => {
    const preferences = [...DEFAULT_SNOOZE_PRESETS];
    preferences[0] = { mode: "absolute", day: "monday", time: "06:00" };
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, hour), preferences);
    expect(presets.find((preset) => preset.id === "preset-0")?.snoozedUntil).toBe(
      localDate(2026, 4, day!, 6).toISOString(),
    );
  });

  it("keeps configured slots distinct when their wake times coincide", () => {
    const presets = resolveSnoozePresets(localDate(2026, 8, 30, 7), DEFAULT_SNOOZE_PRESETS);
    expect(presets.find((preset) => preset.id === "preset-3")?.snoozedUntil).toBe(
      localDate(2026, 8, 31, 9).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "preset-4")?.snoozedUntil).toBe(
      localDate(2026, 8, 31, 9).toISOString(),
    );
  });

  it("omits a Today slot after its time without changing the remaining slot identities", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 19), DEFAULT_SNOOZE_PRESETS);
    expect(presets.map((preset) => preset.id)).toEqual([
      "preset-0",
      "preset-1",
      "preset-3",
      "preset-4",
    ]);
  });

  it.each([
    ["2026-03-06T17:30:00-05:00", "2026-03-13T22:30:00.000Z"],
    ["2026-10-30T17:30:00-04:00", "2026-11-06T21:30:00.000Z"],
  ])("adds elapsed hours across daylight saving changes from %s", (timestamp, expectedWake) => {
    const now = new Date(timestamp);
    const preferences = [...DEFAULT_SNOOZE_PRESETS];
    preferences[0] = { mode: "relative", hours: 168 };
    const presets = resolveSnoozePresets(now, preferences);
    expect(presets[0]?.snoozedUntil).toBe(expectedWake);
    expect(presets[0]?.label).toBe("In 7 days");
  });

  it.each(["tomorrow", "sunday"] as const)(
    "applies the absolute time on the target day for %s across daylight saving changes",
    (day) => {
      const preferences = [...DEFAULT_SNOOZE_PRESETS];
      preferences[0] = { mode: "absolute", day, time: "02:30" };
      const now = localDate(2026, 3, 8, day === "tomorrow" ? 1 : 4);
      const presets = resolveSnoozePresets(now, preferences);
      expect(presets[0]?.snoozedUntil).toBe(
        localDate(2026, 3, day === "tomorrow" ? 9 : 15, 2, 30).toISOString(),
      );
    },
  );

  it("keeps the original evening visibility rule before customization", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("keeps the original Sunday deduplication before customization", () => {
    const presets = resolveSnoozePresets(localDate(2026, 8, 30, 7, 1));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
    ]);
  });
});

it("dismisses a wake at its timestamp without hiding a later wake", () => {
  const firstWake = "2026-04-10T10:00:00.000Z";
  const state = {
    wokeAt: firstWake,
    settled: false,
    lastVisitedAt: null,
    latestRunCompletedAt: null,
  };
  expect(isThreadWokeUnseen(state)).toBe(true);
  expect(isThreadWokeUnseen({ ...state, lastVisitedAt: firstWake })).toBe(false);
  expect(isThreadWokeUnseen({ ...state, lastVisitedAt: firstWake, wokeAt: NOW })).toBe(true);
});
