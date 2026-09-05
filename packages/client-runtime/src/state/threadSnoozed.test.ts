// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  usageLimitSnoozeOffer,
  usageLimitSnoozePreset,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

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
            requestedAt: SNOOZED_AT,
            startedAt: null,
            completedAt: input.turnCompletedAt,
            assistantMessageId: null,
          },
  };
}

type QueuedTurnShell = Pick<
  OrchestrationThreadShell,
  "latestUserMessageAt" | "latestTurn" | "session"
>;

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

describe("usageLimitSnoozeOffer", () => {
  const RESETS_AT = "2026-04-10T14:00:00.000Z";

  function makeLimitShell(
    input: Parameters<typeof makeShell>[0] & { readonly latestUserMessageAt?: string },
  ) {
    return { ...makeShell(input), latestUserMessageAt: input.latestUserMessageAt ?? null };
  }

  it("offers a snooze one minute past the reported reset", () => {
    expect(usageLimitSnoozeOffer(makeLimitShell({}), { resetsAt: RESETS_AT, now: NOW })).toEqual({
      resetsAt: RESETS_AT,
      snoozedUntil: "2026-04-10T14:01:00.000Z",
      snoozable: true,
    });
  });

  it("offers nothing when no limit was reported", () => {
    expect(
      usageLimitSnoozeOffer(makeLimitShell({ sessionStatus: "ready" }), {
        resetsAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("offers nothing once the reset has passed", () => {
    expect(
      usageLimitSnoozeOffer(makeLimitShell({}), {
        resetsAt: "2026-04-10T11:00:00.000Z",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("offers nothing on malformed reset data", () => {
    expect(
      usageLimitSnoozeOffer(makeLimitShell({}), { resetsAt: "not-a-date", now: NOW }),
    ).toBeNull();
  });

  it("stops offering once the user has already snoozed the thread", () => {
    expect(
      usageLimitSnoozeOffer(makeLimitShell({ snoozedUntil: FUTURE_WAKE }), {
        resetsAt: RESETS_AT,
        now: NOW,
      }),
    ).toBeNull();
  });

  // Visibility and actionability are separate: the reset time is worth showing
  // even in the states snooze refuses, which is exactly when a user is stuck.
  it("still reports the limit while the agent is blocked on the user, with snooze off", () => {
    const offer = usageLimitSnoozeOffer(makeLimitShell({ pending: "approval" }), {
      resetsAt: RESETS_AT,
      now: NOW,
    });
    expect(offer?.resetsAt).toBe(RESETS_AT);
    expect(offer?.snoozable).toBe(false);
  });

  // The canonical path: the user sends a message, the provider rejects it for
  // the limit, and no turn adopts it — leaving a queued turn start.
  it("still reports the limit during the queued-turn-start grace, with snooze off", () => {
    const offer = usageLimitSnoozeOffer(
      makeLimitShell({ latestUserMessageAt: "2026-04-10T11:59:30.000Z" }),
      { resetsAt: RESETS_AT, now: NOW },
    );
    expect(offer?.resetsAt).toBe(RESETS_AT);
    expect(offer?.snoozable).toBe(false);
  });

  it("re-enables snooze once the queued-turn-start grace expires", () => {
    const offer = usageLimitSnoozeOffer(
      makeLimitShell({ latestUserMessageAt: "2026-04-10T11:50:00.000Z" }),
      { resetsAt: RESETS_AT, now: NOW },
    );
    expect(offer?.snoozable).toBe(true);
  });
});

describe("usageLimitSnoozePreset", () => {
  const RESETS_AT = "2026-04-10T14:00:00.000Z";

  it("builds a preset a minute past the reset", () => {
    expect(usageLimitSnoozePreset(RESETS_AT, new Date(NOW))).toEqual({
      id: "limits-reset",
      label: "Until limits reset",
      whenLabel: expect.any(String),
      snoozedUntil: "2026-04-10T14:01:00.000Z",
    });
  });

  it("is null once the reset has passed", () => {
    expect(usageLimitSnoozePreset("2026-04-10T11:00:00.000Z", new Date(NOW))).toBeNull();
  });

  it("is null on malformed reset data", () => {
    expect(usageLimitSnoozePreset("not-a-date", new Date(NOW))).toBeNull();
  });
});

describe("resolveSnoozePresets with limitsResetAt", () => {
  const RESETS_AT = "2026-04-10T14:00:00.000Z";

  it("prepends the limits-reset preset when the option resolves to one", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), {
      limitsResetAt: RESETS_AT,
    });
    expect(presets[0]?.id).toBe("limits-reset");
    expect(presets.map((preset) => preset.id)).toEqual([
      "limits-reset",
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
  });

  it("omits the preset when no option is given", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.some((preset) => preset.id === "limits-reset")).toBe(false);
  });

  it("omits the preset when limitsResetAt is null, past, or malformed", () => {
    const now = localDate(2026, 4, 8, 10);
    expect(
      resolveSnoozePresets(now, { limitsResetAt: null }).some(
        (preset) => preset.id === "limits-reset",
      ),
    ).toBe(false);
    expect(
      resolveSnoozePresets(now, {
        limitsResetAt: new Date(now.getTime() - 1_000).toISOString(),
      }).some((preset) => preset.id === "limits-reset"),
    ).toBe(false);
    expect(
      resolveSnoozePresets(now, { limitsResetAt: "not-a-date" }).some(
        (preset) => preset.id === "limits-reset",
      ),
    ).toBe(false);
  });

  it("agrees with usageLimitSnoozeOffer on the wake time", () => {
    const now = "2026-04-10T12:00:00.000Z";
    const shell = makeShell({});
    const offer = usageLimitSnoozeOffer(
      { ...shell, latestUserMessageAt: null },
      { resetsAt: RESETS_AT, now },
    );
    const preset = resolveSnoozePresets(new Date(now), { limitsResetAt: RESETS_AT }).find(
      (candidate) => candidate.id === "limits-reset",
    );
    expect(preset?.snoozedUntil).toBe(offer?.snoozedUntil);
  });
});
