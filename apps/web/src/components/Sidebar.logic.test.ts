import { describe, expect, it } from "vitest";

import {
  compareThreadsByRecentActivity,
  hasUnseenCompletion,
  resolveThreadActivityAt,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("resolveThreadActivityAt", () => {
  it("prefers updatedAt over createdAt when present", () => {
    expect(
      resolveThreadActivityAt({
        id: "thread-1" as never,
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
    ).toBe("2026-03-09T10:05:00.000Z");
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    expect(
      resolveThreadActivityAt({
        id: "thread-1" as never,
        createdAt: "2026-03-09T10:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to createdAt when updatedAt is invalid", () => {
    expect(
      resolveThreadActivityAt({
        id: "thread-1" as never,
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "not-a-date",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });
});

describe("compareThreadsByRecentActivity", () => {
  it("sorts threads by most recent activity first", () => {
    const threads = [
      {
        id: "thread-1" as never,
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:01:00.000Z",
      },
      {
        id: "thread-2" as never,
        createdAt: "2026-03-09T09:00:00.000Z",
        updatedAt: "2026-03-09T10:05:00.000Z",
      },
    ];

    expect(threads.toSorted(compareThreadsByRecentActivity).map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
  });

  it("sorts a valid activity timestamp ahead of an invalid one", () => {
    const threads = [
      {
        id: "thread-1" as never,
        createdAt: "not-a-date",
      },
      {
        id: "thread-2" as never,
        createdAt: "2026-03-09T10:05:00.000Z",
      },
    ];

    expect(threads.toSorted(compareThreadsByRecentActivity).map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
  });

  it("sorts two invalid timestamps by id as a stable fallback", () => {
    const threads = [
      {
        id: "thread-1" as never,
        createdAt: "not-a-date",
      },
      {
        id: "thread-2" as never,
        createdAt: "still-not-a-date",
      },
    ];

    expect(threads.toSorted(compareThreadsByRecentActivity).map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});
