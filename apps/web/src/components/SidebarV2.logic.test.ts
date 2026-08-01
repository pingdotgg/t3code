import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  compactSidebarTimeLabel,
  formatWorkingDurationLabel,
  latestTurnDiffStats,
  resolveSidebarV2Status,
  resolveSidebarV2StatusLabel,
  resolveThreadLifecycleSupport,
  resolveWorkingStartedAt,
  selectSnoozeShelfBulkTargets,
  shouldReserveMacSidebarChrome,
} from "./SidebarV2.logic";
import {
  DEFAULT_INTERACTION_MODE,
  type SidebarThreadSummary,
  type ThreadSession,
  type TurnDiffSummary,
} from "../types";

const now = "2026-01-01T12:00:00.000Z";
const capableEnvironmentId = EnvironmentId.make("environment-capable");
const staleEnvironmentId = EnvironmentId.make("environment-stale");

function descriptor(
  environmentId: EnvironmentId,
  capabilities: { threadSettlement: boolean; threadSnooze: boolean },
): ExecutionEnvironmentDescriptor {
  return { environmentId, capabilities } as unknown as ExecutionEnvironmentDescriptor;
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(`thread-${Math.random()}`),
    environmentId: capableEnvironmentId,
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("shouldReserveMacSidebarChrome", () => {
  it("reserves space for macOS Electron traffic lights only", () => {
    expect(shouldReserveMacSidebarChrome({ isElectron: true, platform: "MacIntel" })).toBe(true);
    expect(shouldReserveMacSidebarChrome({ isElectron: true, platform: "Win32" })).toBe(false);
    expect(shouldReserveMacSidebarChrome({ isElectron: false, platform: "MacIntel" })).toBe(false);
  });
});

describe("resolveThreadLifecycleSupport", () => {
  it("keeps each environment's capabilities independent", () => {
    const support = resolveThreadLifecycleSupport([
      descriptor(capableEnvironmentId, { threadSettlement: true, threadSnooze: true }),
      descriptor(staleEnvironmentId, { threadSettlement: false, threadSnooze: false }),
    ]);

    expect(support.get(capableEnvironmentId)).toEqual({ settlement: true, snooze: true });
    expect(support.get(staleEnvironmentId)).toEqual({ settlement: false, snooze: false });
  });

  it("ignores absent descriptors and reports unknown environments as unsupported", () => {
    const support = resolveThreadLifecycleSupport([null, undefined]);

    expect(support.get(capableEnvironmentId)).toBeUndefined();
  });
});

describe("selectSnoozeShelfBulkTargets", () => {
  const lifecycleSupport = resolveThreadLifecycleSupport([
    descriptor(capableEnvironmentId, { threadSettlement: true, threadSnooze: true }),
    descriptor(staleEnvironmentId, { threadSettlement: false, threadSnooze: false }),
  ]);

  it("excludes threads whose environment cannot snooze", () => {
    const capable = thread();
    const stale = thread({ environmentId: staleEnvironmentId });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [capable, stale],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([capable]);
    expect(targets.reschedulable).toEqual([capable]);
  });

  it("keeps blocked-on-you threads wakeable but not reschedulable", () => {
    const quiet = thread();
    const awaitingApproval = thread({ hasPendingApprovals: true });
    const awaitingInput = thread({ hasPendingUserInput: true });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [quiet, awaitingApproval, awaitingInput],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([quiet, awaitingApproval, awaitingInput]);
    expect(targets.reschedulable).toEqual([quiet]);
  });

  it("excludes a thread whose queued turn has not started yet", () => {
    const queued = thread({ latestUserMessageAt: "2026-01-01T11:59:00.000Z" });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [queued],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([queued]);
    expect(targets.reschedulable).toEqual([]);
  });
});

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    orchestrationStatus: "idle",
    ...overrides,
  } as ThreadSession;
}

describe("resolveSidebarV2Status", () => {
  it("ranks approval above every other signal", () => {
    expect(
      resolveSidebarV2Status(
        thread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: session({ status: "error" }),
        }),
      ),
    ).toBe("approval");
  });

  it("ranks input above working", () => {
    expect(
      resolveSidebarV2Status(
        thread({
          hasPendingUserInput: true,
          latestTurn: {
            turnId: "turn-1",
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          } as SidebarThreadSummary["latestTurn"],
          session: session({ orchestrationStatus: "running" }),
        }),
      ),
    ).toBe("input");
  });

  it("reports a running turn and a connecting session as working", () => {
    expect(
      resolveSidebarV2Status(
        thread({
          latestTurn: {
            turnId: "turn-1",
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          } as SidebarThreadSummary["latestTurn"],
          session: session({ orchestrationStatus: "running" }),
        }),
      ),
    ).toBe("working");
    expect(resolveSidebarV2Status(thread({ session: session({ status: "connecting" }) }))).toBe(
      "working",
    );
  });

  it("reports an errored session as failed and everything else as ready", () => {
    expect(resolveSidebarV2Status(thread({ session: session({ status: "error" }) }))).toBe(
      "failed",
    );
    expect(resolveSidebarV2Status(thread())).toBe("ready");
  });
});

describe("resolveSidebarV2StatusLabel", () => {
  it("labels a ready thread only while its completion is unseen", () => {
    expect(resolveSidebarV2StatusLabel({ status: "ready", unseenCompletion: false })).toBeNull();
    expect(resolveSidebarV2StatusLabel({ status: "ready", unseenCompletion: true })?.label).toBe(
      "Done",
    );
  });

  it("shows the elapsed counter only for working threads", () => {
    expect(
      resolveSidebarV2StatusLabel({ status: "working", unseenCompletion: false })?.showElapsed,
    ).toBe(true);
    expect(
      resolveSidebarV2StatusLabel({ status: "approval", unseenCompletion: false })?.showElapsed,
    ).toBe(false);
  });
});

describe("resolveWorkingStartedAt", () => {
  const startedAt = "2026-01-01T00:00:05.000Z";

  it("prefers the running turn's start, then its request time", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          startedAt,
          requestedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
        } as NonNullable<SidebarThreadSummary["latestTurn"]>,
        session: session(),
      }),
    ).toBe(startedAt);
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          startedAt: null,
          requestedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
        } as NonNullable<SidebarThreadSummary["latestTurn"]>,
        session: session(),
      }),
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls through malformed timestamps instead of only absent ones", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          startedAt: "not-a-date",
          requestedAt: "also-not-a-date",
          completedAt: null,
        } as NonNullable<SidebarThreadSummary["latestTurn"]>,
        session: session({ updatedAt: startedAt }),
      }),
    ).toBe(startedAt);
  });

  it("falls back to the session for a completed turn", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          startedAt: "2026-01-01T00:00:00.000Z",
          requestedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:09.000Z",
        } as NonNullable<SidebarThreadSummary["latestTurn"]>,
        session: session({ updatedAt: startedAt }),
      }),
    ).toBe(startedAt);
  });
});

describe("formatWorkingDurationLabel", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatWorkingDurationLabel(4_200)).toBe("4s");
    expect(formatWorkingDurationLabel(4 * 60_000)).toBe("4m");
    expect(formatWorkingDurationLabel(125 * 60_000)).toBe("2h 5m");
  });

  it("clamps negative and non-finite elapsed values", () => {
    expect(formatWorkingDurationLabel(-1_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("latestTurnDiffStats", () => {
  function summary(files: TurnDiffSummary["files"]): TurnDiffSummary {
    return {
      turnId: "turn-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      files,
    } as TurnDiffSummary;
  }

  it("sums the turn's file changes", () => {
    expect(
      latestTurnDiffStats(
        summary([
          { path: "a.ts", additions: 3, deletions: 1 },
          { path: "b.ts", additions: 2, deletions: 4 },
        ]),
      ),
    ).toEqual({ insertions: 5, deletions: 5 });
  });

  it("prefers turn-scoped files over the full checkpoint", () => {
    const scoped = summary([{ path: "a.ts", additions: 10, deletions: 10 }]);
    expect(
      latestTurnDiffStats({ ...scoped, turnFiles: [{ path: "a.ts", additions: 1, deletions: 2 }] }),
    ).toEqual({ insertions: 1, deletions: 2 });
  });

  it("renders nothing when no line counts are carried", () => {
    expect(latestTurnDiffStats(summary([{ path: "a.ts" }]))).toBeNull();
    expect(latestTurnDiffStats(undefined)).toBeNull();
  });
});

describe("compactSidebarTimeLabel", () => {
  it("drops the trailing ago suffix", () => {
    expect(compactSidebarTimeLabel("3m ago")).toBe("3m");
    expect(compactSidebarTimeLabel("5h ago")).toBe("5h");
    expect(compactSidebarTimeLabel("12d ago")).toBe("12d");
  });

  it("shortens just now and leaves other labels alone", () => {
    expect(compactSidebarTimeLabel("just now")).toBe("now");
    expect(compactSidebarTimeLabel("4h left")).toBe("4h left");
  });

  it("only strips a trailing suffix, never an interior match", () => {
    expect(compactSidebarTimeLabel("ago")).toBe("ago");
  });
});
