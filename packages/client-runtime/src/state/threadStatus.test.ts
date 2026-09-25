import { describe, expect, it } from "vite-plus/test";

import {
  formatWorkingDurationLabel,
  hasUnseenCompletion,
  resolveThreadVisitStamp,
  resolveThreadListStatus,
  resolveWorkingStartedAt,
  withThreadMarkedUnread,
  withThreadVisited,
} from "./threadStatus.ts";

const session = (status: "running" | "starting" | "error" | "idle") =>
  ({ status, updatedAt: "2026-09-23T10:00:00.000Z" }) as never;

describe("resolveThreadListStatus", () => {
  it("shows approval before anything else", () => {
    expect(
      resolveThreadListStatus({
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session: session("running"),
        backgroundLiveness: "working",
      }),
    ).toBe("approval");
  });

  it("keeps working while subagents run after the turn ends", () => {
    expect(
      resolveThreadListStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: session("idle"),
        backgroundLiveness: "working",
      }),
    ).toBe("working");
  });

  it("reads monitoring when only watch loops are live", () => {
    expect(
      resolveThreadListStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: session("idle"),
        backgroundLiveness: "monitoring",
      }),
    ).toBe("monitoring");
  });

  it("lets a failed session outrank stale background liveness", () => {
    expect(
      resolveThreadListStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: session("error"),
        backgroundLiveness: "monitoring",
      }),
    ).toBe("failed");
  });

  it("is ready when nothing is live and the field is absent", () => {
    expect(
      resolveThreadListStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: null,
      }),
    ).toBe("ready");
  });
});

describe("hasUnseenCompletion", () => {
  const latestTurn = { completedAt: "2026-09-23T10:05:00.000Z" } as never;

  it("is unread when the turn finished after the last visit", () => {
    expect(hasUnseenCompletion({ latestTurn }, "2026-09-23T10:00:00.000Z")).toBe(true);
  });

  it("is read once the visit is stamped at the completion", () => {
    expect(hasUnseenCompletion({ latestTurn }, "2026-09-23T10:05:00.000Z")).toBe(false);
  });

  it("treats a never-visited thread as read", () => {
    expect(hasUnseenCompletion({ latestTurn }, undefined)).toBe(false);
  });

  it("treats an unreadable visit stamp as unread", () => {
    expect(hasUnseenCompletion({ latestTurn }, "not a date")).toBe(true);
  });
});

describe("resolveThreadVisitStamp", () => {
  const updatedAt = "2026-01-01T00:00:00.000Z";

  it("stamps the latest completion when there is one", () => {
    expect(
      resolveThreadVisitStamp({
        updatedAt,
        latestTurn: {
          requestedAt: "2026-01-01T00:00:05.000Z",
          completedAt: "2026-01-01T00:00:10.000Z",
        } as never,
      }),
    ).toBe("2026-01-01T00:00:10.000Z");
  });

  it("stamps the running turn's request time, so its completion reads unread", () => {
    const requestedAt = "2026-01-01T00:00:05.000Z";
    const stamp = resolveThreadVisitStamp({
      updatedAt,
      latestTurn: { requestedAt, completedAt: null } as never,
    });
    expect(stamp).toBe(requestedAt);
    expect(
      hasUnseenCompletion(
        { latestTurn: { completedAt: "2026-01-01T00:00:20.000Z" } as never },
        stamp,
      ),
    ).toBe(true);
  });

  it("stamps the thread's last server update when it has no turn yet", () => {
    expect(resolveThreadVisitStamp({ updatedAt, latestTurn: null })).toBe(updatedAt);
  });
});

describe("thread visits", () => {
  it("never moves a visit backwards", () => {
    const visits = { a: "2026-09-23T10:05:00.000Z" };
    expect(withThreadVisited(visits, "a", "2026-09-23T10:00:00.000Z")).toBe(visits);
  });

  it("advances a visit and leaves other threads alone", () => {
    expect(
      withThreadVisited({ a: "2026-09-23T10:00:00.000Z" }, "b", "2026-09-23T10:01:00.000Z"),
    ).toEqual({
      a: "2026-09-23T10:00:00.000Z",
      b: "2026-09-23T10:01:00.000Z",
    });
  });

  it("ignores an unreadable visit", () => {
    const visits = {};
    expect(withThreadVisited(visits, "a", "nope")).toBe(visits);
  });

  it("marks unread one millisecond before the completion", () => {
    expect(withThreadMarkedUnread({}, "a", "2026-09-23T10:05:00.000Z")).toEqual({
      a: "2026-09-23T10:04:59.999Z",
    });
  });
});

describe("working timer", () => {
  it("counts from the running turn's start, then request time, then the session", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          completedAt: null,
          startedAt: "bad",
          requestedAt: "2026-09-23T10:00:00.000Z",
        } as never,
        session: session("running"),
      }),
    ).toBe("2026-09-23T10:00:00.000Z");
  });

  it("formats seconds, minutes and hours", () => {
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(65 * 60_000)).toBe("1h 5m");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});
