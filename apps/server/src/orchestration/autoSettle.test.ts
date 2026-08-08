import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAutoSettleVerdict, threadLastActivityAt } from "./autoSettle.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

function makeShell(input: {
  readonly settledOverride?: "settled" | "active" | null;
  readonly activityAt: string | null;
  readonly sessionStatus?: "starting" | "running" | "error";
  readonly pending?: "approval" | "user-input";
  readonly pinnedAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly latestUserMessageAt?: string | null;
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
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: null,
    pinnedAt: input.pinnedAt ?? null,
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
  };
}

describe("threadLastActivityAt", () => {
  it("returns the newest user or turn timestamp", () => {
    const shell = {
      latestUserMessageAt: "2026-04-04T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed" as const,
        requestedAt: "2026-04-03T00:00:00.000Z",
        startedAt: "2026-04-05T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:00.000Z",
        assistantMessageId: null,
      },
      snoozedUntil: null,
    };
    expect(threadLastActivityAt(shell, Date.parse(NOW))).toBe("2026-04-06T00:00:00.000Z");
    expect(
      threadLastActivityAt({ latestUserMessageAt: null, latestTurn: null, snoozedUntil: null }, 0),
    ).toBeNull();
  });

  it("counts an elapsed snooze wake as activity, so a woken thread gets a fresh window", () => {
    const wokeAt = "2026-04-09T09:00:00.000Z";
    const shell = {
      latestUserMessageAt: STALE,
      latestTurn: null,
      snoozedUntil: wokeAt,
    };
    expect(threadLastActivityAt(shell, Date.parse(NOW))).toBe(wokeAt);
    // A wake still in the future is not activity (the thread is snoozed, and
    // the verdict skips it anyway).
    expect(threadLastActivityAt(shell, Date.parse("2026-04-09T08:00:00.000Z"))).toBe(STALE);
  });
});

describe("resolveAutoSettleVerdict", () => {
  const base = { now: NOW, autoSettleAfterDays: 3, changeRequestState: "none" as const };

  it("settles a quiet thread past the window", () => {
    expect(resolveAutoSettleVerdict(makeShell({ activityAt: STALE }), base)).toEqual({
      kind: "settle",
    });
  });

  it("leaves fresh threads and threads with no recorded activity alone", () => {
    expect(resolveAutoSettleVerdict(makeShell({ activityAt: FRESH }), base).kind).toBe("skip");
    expect(resolveAutoSettleVerdict(makeShell({ activityAt: null }), base).kind).toBe("skip");
  });

  it("skips any explicit override, pinned, and still-snoozed threads", () => {
    const stale = { activityAt: STALE } as const;
    expect(
      resolveAutoSettleVerdict(makeShell({ ...stale, settledOverride: "settled" }), base).kind,
    ).toBe("skip");
    expect(
      resolveAutoSettleVerdict(makeShell({ ...stale, settledOverride: "active" }), base).kind,
    ).toBe("skip");
    expect(resolveAutoSettleVerdict(makeShell({ ...stale, pinnedAt: FRESH }), base).kind).toBe(
      "skip",
    );
    expect(
      resolveAutoSettleVerdict(
        makeShell({ ...stale, snoozedUntil: "2026-04-11T00:00:00.000Z" }),
        base,
      ).kind,
    ).toBe("skip");
  });

  it("skips blocked-on-you and live-session threads", () => {
    const stale = { activityAt: STALE } as const;
    for (const shell of [
      makeShell({ ...stale, pending: "approval" }),
      makeShell({ ...stale, pending: "user-input" }),
      makeShell({ ...stale, sessionStatus: "starting" }),
      makeShell({ ...stale, sessionStatus: "running" }),
    ]) {
      expect(resolveAutoSettleVerdict(shell, base).kind).toBe("skip");
    }
  });

  it("skips a queued turn start within the grace window", () => {
    const messageAt = "2026-04-09T12:00:00.000Z";
    const queued = makeShell({ activityAt: STALE, latestUserMessageAt: messageAt });
    expect(
      resolveAutoSettleVerdict(queued, {
        ...base,
        now: "2026-04-09T12:00:30.000Z",
        changeRequestState: "merged",
      }).kind,
    ).toBe("skip");
  });

  it("settles immediately on a merged or closed PR, however fresh the thread", () => {
    const fresh = makeShell({ activityAt: FRESH });
    for (const changeRequestState of ["merged", "closed"] as const) {
      expect(resolveAutoSettleVerdict(fresh, { ...base, changeRequestState })).toEqual({
        kind: "settle",
      });
    }
  });

  it("never settles behind an open PR, however quiet the thread", () => {
    const stale = makeShell({ activityAt: STALE });
    expect(resolveAutoSettleVerdict(stale, { ...base, changeRequestState: "open" }).kind).toBe(
      "skip",
    );
  });

  it("asks for PR verification before an inactivity settle with unknown PR state", () => {
    const stale = makeShell({ activityAt: STALE });
    expect(resolveAutoSettleVerdict(stale, { ...base, changeRequestState: "unknown" }).kind).toBe(
      "verify-pr",
    );
    // Merged/closed need no verification: unknown only gates the quiet path.
    const fresh = makeShell({ activityAt: FRESH });
    expect(resolveAutoSettleVerdict(fresh, { ...base, changeRequestState: "unknown" }).kind).toBe(
      "skip",
    );
  });

  it("honors a disabled inactivity window", () => {
    const stale = makeShell({ activityAt: STALE });
    expect(resolveAutoSettleVerdict(stale, { ...base, autoSettleAfterDays: null }).kind).toBe(
      "skip",
    );
    // Merged PRs still settle with the window off.
    expect(
      resolveAutoSettleVerdict(stale, {
        ...base,
        autoSettleAfterDays: null,
        changeRequestState: "merged",
      }).kind,
    ).toBe("settle");
  });

  it("uses a strict window boundary", () => {
    const boundary = makeShell({ activityAt: "2026-04-07T00:00:00.000Z" });
    expect(resolveAutoSettleVerdict(boundary, base).kind).toBe("skip");
  });

  it("does not settle a woken thread until a fresh window elapses after the wake", () => {
    const wokeRecently = makeShell({
      activityAt: STALE,
      snoozedUntil: "2026-04-09T09:00:00.000Z",
    });
    expect(resolveAutoSettleVerdict(wokeRecently, base).kind).toBe("skip");
    const wokeLongAgo = makeShell({
      activityAt: "2026-04-01T00:00:00.000Z",
      snoozedUntil: "2026-04-02T00:00:00.000Z",
    });
    expect(resolveAutoSettleVerdict(wokeLongAgo, base)).toEqual({ kind: "settle" });
  });

  it("re-verifies a cached open PR instead of trusting it to block settle", () => {
    // A cached "open" may be stale (the PR could have merged since polling
    // stopped), so a quiet thread asks for live verification rather than
    // staying active forever on stale data.
    const stale = makeShell({ activityAt: STALE });
    expect(
      resolveAutoSettleVerdict(stale, { ...base, changeRequestState: "open-cached" }).kind,
    ).toBe("verify-pr");
    // A fresh thread with a cached open PR needs nothing: the inactivity
    // path is not in play yet.
    const fresh = makeShell({ activityAt: FRESH });
    expect(
      resolveAutoSettleVerdict(fresh, { ...base, changeRequestState: "open-cached" }).kind,
    ).toBe("skip");
  });

  it("re-verifies a cached closed PR instead of settling on it", () => {
    // A closed PR can be REOPENED; only a live-confirmed close settles. The
    // check applies regardless of recency, like the live merged/closed path.
    for (const shell of [makeShell({ activityAt: FRESH }), makeShell({ activityAt: STALE })]) {
      expect(
        resolveAutoSettleVerdict(shell, { ...base, changeRequestState: "closed-cached" }).kind,
      ).toBe("verify-pr");
    }
  });

  it("clamps future-stamped activity to now instead of blocking settle forever", () => {
    // A client clock far ahead must not hold the thread permanently fresh.
    // The future stamp counts as activity NOW: still active within the
    // window measured from the sweep's own clock...
    const futureStamped = makeShell({ activityAt: "2026-04-20T00:00:00.000Z" });
    expect(resolveAutoSettleVerdict(futureStamped, base).kind).toBe("skip");
    // ...but once the sweep's clock alone moves a full window past the
    // stamp, the thread settles — the skew cannot extend the window.
    expect(
      resolveAutoSettleVerdict(futureStamped, { ...base, now: "2026-04-24T00:00:00.001Z" }).kind,
    ).toBe("settle");
  });
});
