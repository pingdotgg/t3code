import {
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  canAdmitSettledAutoArchiveNow,
  canAutoArchiveSettledThreadNow,
  isSettledAutoArchiveCandidate,
  normalizeSettledAutoArchiveAfterDays,
  planSettledAutoArchive,
  resolveSettledAutoArchiveDue,
  settledAutoArchiveCommandId,
} from "./SettledAutoArchive.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = "2026-09-01T00:00:00.000Z";
const iso = (ms: number) => new Date(ms).toISOString();
// Negative extraMs pushes further into the past (past the due boundary).
const daysAgo = (days: number, extraMs = 0) => iso(Date.parse(NOW) - days * DAY_MS + extraMs);

function settledThread(
  id: string,
  settledAt: string | null,
  overrides: Record<string, unknown> = {},
): OrchestrationThread {
  return {
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: "settled",
    settledAt,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    latestTurn: null,
    session: null,
    messages: [],
    activities: [],
    ...overrides,
    id: ThreadId.make(id),
  } as unknown as OrchestrationThread;
}

const activity = (kind: string, requestId: string | null = null) =>
  ({
    id: `activity-${kind}-${requestId ?? "none"}`,
    tone: "info",
    kind,
    summary: kind,
    payload: requestId === null ? {} : { requestId },
    turnId: null,
    createdAt: NOW,
  }) as never;

const userMessage = (createdAt: string) => ({ role: "user", createdAt }) as never;

const readModel = (threads: ReadonlyArray<OrchestrationThread>) =>
  ({
    snapshotSequence: 0,
    projects: [],
    threads,
    workflowRuns: [],
    updatedAt: NOW,
  }) as unknown as OrchestrationReadModel;

describe("isSettledAutoArchiveCandidate", () => {
  it("accepts a quiet settled thread regardless of the clock", () => {
    expect(isSettledAutoArchiveCandidate(settledThread("root", NOW), NOW)).toBe(true);
  });

  it("rejects threads that are not settled", () => {
    for (const settledOverride of [null, "active"]) {
      expect(
        isSettledAutoArchiveCandidate(settledThread("root", daysAgo(3), { settledOverride }), NOW),
      ).toBe(false);
    }
  });

  it("rejects a missing or malformed settledAt", () => {
    expect(isSettledAutoArchiveCandidate(settledThread("root", null), NOW)).toBe(false);
    expect(isSettledAutoArchiveCandidate(settledThread("root", "not-a-date"), NOW)).toBe(false);
  });

  it("rejects archived and deleted threads", () => {
    expect(
      isSettledAutoArchiveCandidate(settledThread("root", daysAgo(3), { archivedAt: NOW }), NOW),
    ).toBe(false);
    expect(
      isSettledAutoArchiveCandidate(settledThread("root", daysAgo(3), { deletedAt: NOW }), NOW),
    ).toBe(false);
  });

  it("skips pinned threads", () => {
    expect(
      isSettledAutoArchiveCandidate(settledThread("root", daysAgo(3), { pinnedAt: NOW }), NOW),
    ).toBe(false);
  });

  it("skips effectively snoozed threads but lets expired snoozes through", () => {
    const future = iso(Date.parse(NOW) + 60 * 60 * 1_000);
    const past = iso(Date.parse(NOW) - 60 * 60 * 1_000);
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), { snoozedUntil: future }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSettledAutoArchiveCandidate(settledThread("root", daysAgo(3), { snoozedUntil: past }), NOW),
    ).toBe(true);
  });

  it("does not treat a thread that raised its hand while snoozed as snoozed", () => {
    const future = iso(Date.parse(NOW) + 60 * 60 * 1_000);
    const snoozedAt = iso(Date.parse(NOW) - 2 * 60 * 60 * 1_000);
    const completedAt = iso(Date.parse(NOW) - 60 * 60 * 1_000);
    const thread = settledThread("root", daysAgo(3), {
      snoozedUntil: future,
      snoozedAt,
      latestTurn: { turnId: "turn-1", state: "completed", completedAt },
    });
    expect(isSettledAutoArchiveCandidate(thread, NOW)).toBe(true);
  });

  it("vetoes pending approvals and user input", () => {
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), { activities: [activity("approval.requested", "r1")] }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), { activities: [activity("user-input.requested", "r2")] }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), {
          activities: [activity("approval.requested", "r1"), activity("approval.resolved", "r1")],
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("vetoes live or failed sessions but allows idle ones", () => {
    for (const status of ["starting", "running", "error"]) {
      expect(
        isSettledAutoArchiveCandidate(
          settledThread("root", daysAgo(3), {
            session: { status, activeTurnId: null, updatedAt: NOW },
          }),
          NOW,
        ),
      ).toBe(false);
    }
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), {
          session: { status: "idle", activeTurnId: null, updatedAt: NOW },
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("vetoes a running turn even without a live session", () => {
    const thread = settledThread("root", daysAgo(3), {
      latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
    });
    expect(isSettledAutoArchiveCandidate(thread, NOW)).toBe(false);
  });

  it("vetoes a queued turn start but lets stale user messages through", () => {
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), { messages: [userMessage(NOW)] }),
        NOW,
      ),
    ).toBe(false);
    const stale = iso(Date.parse(NOW) - 10 * 60 * 1_000);
    expect(
      isSettledAutoArchiveCandidate(
        settledThread("root", daysAgo(3), { messages: [userMessage(stale)] }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("resolveSettledAutoArchiveDue", () => {
  it("is due once the full day count has elapsed", () => {
    expect(resolveSettledAutoArchiveDue(settledThread("root", daysAgo(2, -1_000)), NOW, 2)).toBe(
      true,
    );
    expect(resolveSettledAutoArchiveDue(settledThread("root", daysAgo(2)), NOW, 2)).toBe(true);
    expect(resolveSettledAutoArchiveDue(settledThread("root", daysAgo(2, 1_000)), NOW, 2)).toBe(
      false,
    );
    expect(resolveSettledAutoArchiveDue(settledThread("root", NOW), NOW, 2)).toBe(false);
  });

  it("honours custom day counts", () => {
    expect(resolveSettledAutoArchiveDue(settledThread("root", daysAgo(6)), NOW, 7)).toBe(false);
    expect(resolveSettledAutoArchiveDue(settledThread("root", daysAgo(7, -1_000)), NOW, 7)).toBe(
      true,
    );
  });

  it("never treats a missing or malformed settledAt as due", () => {
    expect(resolveSettledAutoArchiveDue(settledThread("root", null), NOW, 2)).toBe(false);
    expect(resolveSettledAutoArchiveDue(settledThread("root", "not-a-date"), NOW, 2)).toBe(false);
  });
});

describe("normalizeSettledAutoArchiveAfterDays", () => {
  it("passes numbers through and null through as never", () => {
    expect(normalizeSettledAutoArchiveAfterDays(5)).toBe(5);
    expect(normalizeSettledAutoArchiveAfterDays(null)).toBeNull();
    expect(normalizeSettledAutoArchiveAfterDays(undefined)).toBeNull();
  });

  it("falls back to the two-day default for garbage", () => {
    expect(normalizeSettledAutoArchiveAfterDays("soon")).toBe(2);
    expect(normalizeSettledAutoArchiveAfterDays(Number.NaN)).toBe(2);
  });
});

describe("canAutoArchiveSettledThreadNow and planSettledAutoArchive", () => {
  it("archives a due root and skips a fresh one", () => {
    const model = readModel([settledThread("due", daysAgo(3)), settledThread("fresh", NOW)]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("due"), NOW, 2)).toBe(true);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("fresh"), NOW, 2)).toBe(false);
    expect(planSettledAutoArchive(model, NOW, 2).map((candidate) => candidate.threadId)).toEqual([
      ThreadId.make("due"),
    ]);
  });

  it("treats null days as never", () => {
    const model = readModel([settledThread("due", daysAgo(30))]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("due"), NOW, null)).toBe(false);
    expect(planSettledAutoArchive(model, NOW, null)).toEqual([]);
  });

  it("vetoes a due root with an active descendant", () => {
    const model = readModel([
      settledThread("parent", daysAgo(3)),
      settledThread("child", daysAgo(3), {
        parentThreadId: ThreadId.make("parent"),
        latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
      }),
    ]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("parent"), NOW, 2)).toBe(false);
    expect(planSettledAutoArchive(model, NOW, 2)).toEqual([]);
  });

  it("vetoes a due root with an unsettled descendant", () => {
    const model = readModel([
      settledThread("parent", daysAgo(3)),
      settledThread("child", null, {
        parentThreadId: ThreadId.make("parent"),
        settledOverride: null,
      }),
    ]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("parent"), NOW, 2)).toBe(false);
    expect(planSettledAutoArchive(model, NOW, 2)).toEqual([]);
  });

  it("holds a due root while a descendant's own clock is still running", () => {
    const model = readModel([
      settledThread("parent", daysAgo(3)),
      settledThread("child", NOW, { parentThreadId: ThreadId.make("parent") }),
    ]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("parent"), NOW, 2)).toBe(false);
    expect(planSettledAutoArchive(model, NOW, 2)).toEqual([]);
  });

  it("dispatches only the topmost due root for a nested due subtree", () => {
    const model = readModel([
      settledThread("parent", daysAgo(3)),
      settledThread("child", daysAgo(4), { parentThreadId: ThreadId.make("parent") }),
    ]);
    expect(planSettledAutoArchive(model, NOW, 2).map((candidate) => candidate.threadId)).toEqual([
      ThreadId.make("parent"),
    ]);
  });

  it("still archives a due child under an active parent", () => {
    const model = readModel([
      settledThread("parent", null, { settledOverride: null }),
      settledThread("child", daysAgo(3), { parentThreadId: ThreadId.make("parent") }),
    ]);
    expect(planSettledAutoArchive(model, NOW, 2).map((candidate) => candidate.threadId)).toEqual([
      ThreadId.make("child"),
    ]);
  });

  it("rejects unknown threads", () => {
    const model = readModel([]);
    expect(canAutoArchiveSettledThreadNow(model, ThreadId.make("missing"), NOW, 2)).toBe(false);
  });
});

describe("canAdmitSettledAutoArchiveNow", () => {
  it("abstains on unsettled threads so the merge archiver still admits them", () => {
    const model = readModel([settledThread("active", null, { settledOverride: null })]);
    expect(canAdmitSettledAutoArchiveNow(model, ThreadId.make("active"), NOW, 2)).toBe(true);
  });

  it("abstains on unknown threads", () => {
    const model = readModel([]);
    expect(canAdmitSettledAutoArchiveNow(model, ThreadId.make("missing"), NOW, 2)).toBe(true);
  });

  it("admits a due settled thread and defers a fresh one", () => {
    const model = readModel([settledThread("due", daysAgo(3)), settledThread("fresh", NOW)]);
    expect(canAdmitSettledAutoArchiveNow(model, ThreadId.make("due"), NOW, 2)).toBe(true);
    expect(canAdmitSettledAutoArchiveNow(model, ThreadId.make("fresh"), NOW, 2)).toBe(false);
  });

  it("still vetoes settled threads when the setting is null (never)", () => {
    const model = readModel([settledThread("due", daysAgo(30))]);
    expect(canAdmitSettledAutoArchiveNow(model, ThreadId.make("due"), NOW, null)).toBe(false);
    // ...while unsettled threads keep abstaining so other archivers proceed.
    const mixed = readModel([
      settledThread("due", daysAgo(30)),
      settledThread("active", null, { settledOverride: null }),
    ]);
    expect(canAdmitSettledAutoArchiveNow(mixed, ThreadId.make("active"), NOW, null)).toBe(true);
  });
});

describe("settledAutoArchiveCommandId", () => {
  it("namespaces the command so receipts deduplicate per thread", () => {
    const first = settledAutoArchiveCommandId(ThreadId.make("root"));
    const second = settledAutoArchiveCommandId(ThreadId.make("root"));
    expect(first.startsWith("server:settled-archive:")).toBe(true);
    expect(first).toContain(ThreadId.make("root"));
    expect(first).not.toBe(second);
  });
});
