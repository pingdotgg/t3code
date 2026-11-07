import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortInboxThreadsBySend,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(sortInboxThreadsByReturn([a, b], tracker.returnedAt).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("sortInboxThreadsBySend", () => {
  const inboxThread = (
    id: string,
    overrides: Partial<
      Pick<
        EnvironmentThreadShell,
        | "latestRun"
        | "latestRunCompletedAt"
        | "latestUserMessageAt"
        | "latestUserAuthoredMessageAt"
        | "unsettledAt"
      >
    > = {},
  ) => ({
    ...thread(id, false),
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    ...overrides,
  });

  it("orders by the last message the user sent, ignoring agent runs", () => {
    const sentEarly = inboxThread("sent-early", {
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:late"),
        status: "completed" as const,
        requestedAt: "2026-06-01T05:00:00.000Z",
        startedAt: "2026-06-01T05:00:00.000Z",
        completedAt: "2026-06-01T06:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const sentLate = inboxThread("sent-late", {
      latestUserAuthoredMessageAt: "2026-06-01T03:00:00.000Z",
    });
    const untouched = inboxThread("untouched");
    expect(
      sortInboxThreadsBySend([untouched, sentEarly, sentLate]).map((entry) => entry.id),
    ).toEqual(["sent-late", "sent-early", "untouched"]);
  });

  it("falls back to the latest user message when authorship is unknown", () => {
    const { latestUserAuthoredMessageAt: _unknown, ...legacy } = inboxThread("legacy", {
      latestUserMessageAt: "2026-06-01T04:00:00.000Z",
    });
    const sent = inboxThread("sent", {
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    });
    expect(sortInboxThreadsBySend([sent, legacy]).map((entry) => entry.id)).toEqual([
      "legacy",
      "sent",
    ]);
  });

  it("puts un-settled and returned threads back on top", () => {
    const sent = inboxThread("sent", {
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    });
    const unsettled = inboxThread("unsettled", { unsettledAt: "2026-06-01T03:00:00.000Z" });
    const returned = inboxThread("returned");
    expect(
      sortInboxThreadsBySend([sent, unsettled, returned], (entry) =>
        entry.id === "returned" ? Date.parse("2026-06-01T04:00:00.000Z") : undefined,
      ).map((entry) => entry.id),
    ).toEqual(["returned", "unsettled", "sent"]);
  });

  it("keeps a finished run's return after a reload, only with the Working section", () => {
    const returnedEarlier = inboxThread("returned-earlier", {
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:done"),
        status: "completed" as const,
        requestedAt: "2026-06-01T01:00:00.000Z",
        startedAt: "2026-06-01T01:00:00.000Z",
        completedAt: "2026-06-01T03:00:00.000Z",
        assistantMessageId: null,
      },
      latestRunCompletedAt: "2026-06-01T03:00:00.000Z",
    });
    const sentLater = inboxThread("sent-later", {
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    });
    // A fresh page has no observed returns yet.
    expect(
      sortInboxThreadsBySend([sentLater, returnedEarlier], () => undefined).map(
        (entry) => entry.id,
      ),
    ).toEqual(["returned-earlier", "sent-later"]);
    expect(sortInboxThreadsBySend([sentLater, returnedEarlier]).map((entry) => entry.id)).toEqual([
      "sent-later",
      "returned-earlier",
    ]);
  });

  it("keeps a run waiting on you on top after a reload", () => {
    const awaiting = inboxThread("awaiting", {
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:approval"),
        status: "waiting" as const,
        requestedAt: "2026-06-01T03:00:00.000Z",
        startedAt: "2026-06-01T03:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const sentLater = inboxThread("sent-later", {
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    });
    expect(
      sortInboxThreadsBySend([sentLater, awaiting], () => undefined).map((entry) => entry.id),
    ).toEqual(["awaiting", "sent-later"]);
  });

  it("ignores a completion time the server did not report", () => {
    // Older servers omit it, so `latestRun.completedAt` is the thread's `updatedAt`.
    const touched = inboxThread("touched", {
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:legacy"),
        status: "completed" as const,
        requestedAt: "2026-06-01T01:00:00.000Z",
        startedAt: "2026-06-01T01:00:00.000Z",
        completedAt: "2026-06-01T03:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const sentLater = inboxThread("sent-later", {
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    });
    expect(
      sortInboxThreadsBySend([sentLater, touched], () => undefined).map((entry) => entry.id),
    ).toEqual(["sent-later", "touched"]);
  });
});
