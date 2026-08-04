import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  classifySidebarV2Shelves,
  compactSidebarTimeLabel,
  formatWorkingDurationLabel,
  isSidebarV2ArchiveBlockedThread,
  resolveSidebarV2Status,
  resolveSidebarV2StatusLabel,
  resolveSidebarV2ThreadRouteTarget,
  resolveThreadLifecycleSupport,
  resolveWorkingStartedAt,
  selectSnoozeShelfBulkTargets,
  shouldReserveMacSidebarChrome,
  type SidebarV2ThreadGroup,
} from "./SidebarV2.logic";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary, type ThreadSession } from "../types";

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

function rootsOf(groups: readonly SidebarV2ThreadGroup[]): readonly SidebarThreadSummary[] {
  return groups.map((group) => group.root);
}

function rowTitles(groups: readonly SidebarV2ThreadGroup[]): readonly string[] {
  return groups.flatMap((group) =>
    group.rows.map((row) => `${"  ".repeat(row.depth)}${row.thread.title}`),
  );
}

describe("classifySidebarV2Shelves", () => {
  it("keeps pinned threads in their durable project order and out of other shelves", () => {
    const projectId = ProjectId.make("project-1");
    const first = thread({ id: ThreadId.make("first"), projectId });
    const second = thread({ id: ThreadId.make("second"), projectId });
    const active = thread({ id: ThreadId.make("active"), projectId });
    const projectKey = `${capableEnvironmentId}:${projectId}`;
    const firstKey = `${capableEnvironmentId}:${first.id}`;
    const secondKey = `${capableEnvironmentId}:${second.id}`;

    const shelves = classifySidebarV2Shelves({
      threads: [first, second, active],
      now,
      pinnedThreadKeysByProjectKey: {
        [projectKey]: [secondKey, firstKey],
      },
    });

    expect(rootsOf(shelves.pinned)).toEqual([second, first]);
    expect(rootsOf(shelves.pinnedByProjectKey.get(projectKey) ?? [])).toEqual([second, first]);
    expect(rootsOf(shelves.active)).toEqual([active]);
    expect(shelves.snoozed).toEqual([]);
    expect(shelves.settled).toEqual([]);
  });

  it("ignores stale and wrongly scoped pin entries", () => {
    const realThread = thread({ id: ThreadId.make("real") });
    const projectKey = `${capableEnvironmentId}:${realThread.projectId}`;

    const shelves = classifySidebarV2Shelves({
      threads: [realThread],
      now,
      pinnedThreadKeysByProjectKey: {
        [projectKey]: ["missing"],
        other: [`${capableEnvironmentId}:${realThread.id}`],
      },
    });

    expect(shelves.pinned).toEqual([]);
    expect(rootsOf(shelves.active)).toEqual([realThread]);
  });

  it("excludes descendants of archived parents before shelf classification", () => {
    const archivedParent = thread({
      id: ThreadId.make("archived-parent"),
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const archivedChild = thread({
      id: ThreadId.make("archived-child"),
      parentThreadId: archivedParent.id,
      settledOverride: "settled",
    });
    const archivedGrandchild = thread({
      id: ThreadId.make("archived-grandchild"),
      parentThreadId: archivedChild.id,
      snoozedUntil: "2026-01-02T00:00:00.000Z",
    });
    const visibleThread = thread({ id: ThreadId.make("visible") });

    const shelves = classifySidebarV2Shelves({
      threads: [archivedParent, archivedChild, archivedGrandchild, visibleThread],
      now,
    });

    expect(rootsOf(shelves.active)).toEqual([visibleThread]);
    expect(shelves.snoozed).toEqual([]);
    expect(shelves.settled).toEqual([]);
  });

  it("nests chats under their parent instead of listing them as siblings", () => {
    const parent = thread({ id: ThreadId.make("parent"), title: "Parent" });
    const child = thread({
      id: ThreadId.make("child"),
      parentThreadId: parent.id,
      title: "Child",
    });
    const grandchild = thread({
      id: ThreadId.make("grandchild"),
      parentThreadId: child.id,
      title: "Grandchild",
    });

    const shelves = classifySidebarV2Shelves({
      threads: [grandchild, child, parent],
      now,
      expandedOverrideByThreadKey: new Map([
        [`${capableEnvironmentId}:${parent.id}`, true],
        [`${capableEnvironmentId}:${child.id}`, true],
      ]),
    });

    expect(rootsOf(shelves.active)).toEqual([parent]);
    expect(rowTitles(shelves.active)).toEqual(["Parent", "  Child", "    Grandchild"]);
  });

  it("keeps a settled parent's subtree together and rolls the child up while collapsed", () => {
    const parent = thread({
      id: ThreadId.make("parent"),
      title: "Parent",
      settledOverride: "settled",
    });
    const child = thread({
      id: ThreadId.make("child"),
      parentThreadId: parent.id,
      title: "Child",
      settledOverride: "settled",
    });

    const settledShelves = classifySidebarV2Shelves({ threads: [parent, child], now });
    expect(rootsOf(settledShelves.settled)).toEqual([parent]);
    expect(rowTitles(settledShelves.settled)).toEqual(["Parent"]);
    expect(settledShelves.settled[0]?.rows[0]?.displayStatus).toBe("ready");

    const workingChild = { ...child, hasPendingApprovals: true };
    const promotedShelves = classifySidebarV2Shelves({ threads: [parent, workingChild], now });
    // A settled parent cannot bury a child that is blocked on the user.
    expect(rootsOf(promotedShelves.active)).toEqual([parent]);
    expect(promotedShelves.settled).toEqual([]);
    expect(rowTitles(promotedShelves.active)).toEqual(["Parent", "  Child"]);
    expect(promotedShelves.active[0]?.rows[0]?.displayStatus).toBe("approval");
  });

  it("keeps a collapsed parent's routed descendant visible", () => {
    const parent = thread({ id: ThreadId.make("parent"), title: "Parent" });
    const child = thread({
      id: ThreadId.make("child"),
      parentThreadId: parent.id,
      title: "Child",
    });

    const collapsed = classifySidebarV2Shelves({
      threads: [parent, child],
      now,
      expandedOverrideByThreadKey: new Map([[`${capableEnvironmentId}:${parent.id}`, false]]),
    });
    expect(rowTitles(collapsed.active)).toEqual(["Parent"]);

    const routed = classifySidebarV2Shelves({
      threads: [parent, child],
      now,
      expandedOverrideByThreadKey: new Map([[`${capableEnvironmentId}:${parent.id}`, false]]),
      activeThreadKey: `${capableEnvironmentId}:${child.id}`,
    });
    expect(rowTitles(routed.active)).toEqual(["Parent", "  Child"]);
  });

  it("keeps a selected completed agent-run row visible under an explicit collapse", () => {
    const parent = thread({ id: ThreadId.make("parent-thread"), title: "Parent" });
    const agentRun = thread({
      id: ThreadId.make("agent-run:parent-thread:agent-1"),
      parentThreadId: parent.id,
      title: "Agent",
      virtualAgentRun: {
        parentThreadId: parent.id,
        taskId: "agent-1",
        status: "completed",
      },
    });

    const collapsed = classifySidebarV2Shelves({
      threads: [parent, agentRun],
      now,
      expandedOverrideByThreadKey: new Map([[`${capableEnvironmentId}:${parent.id}`, false]]),
      // Parent path key alone would leave the completed agent row hidden.
      activeThreadKey: `${capableEnvironmentId}:agent-run:parent-thread:agent-1`,
    });

    expect(rowTitles(collapsed.active)).toEqual(["Parent", "  Agent"]);
  });

  it("blocks archive on a quiet parent when a descendant turn is running", () => {
    const parent = thread({ id: ThreadId.make("parent"), title: "Parent" });
    const idleChild = thread({
      id: ThreadId.make("idle-child"),
      parentThreadId: parent.id,
      title: "Idle child",
    });
    const runningGrandchild = thread({
      id: ThreadId.make("running-grandchild"),
      parentThreadId: idleChild.id,
      title: "Running grandchild",
      session: session({
        status: "running",
        activeTurnId: "turn-1" as never,
        orchestrationStatus: "running",
      }),
    });
    const runningAgent = thread({
      id: ThreadId.make("agent-run:idle-child:agent-1"),
      parentThreadId: idleChild.id,
      title: "Agent",
      virtualAgentRun: {
        parentThreadId: idleChild.id,
        taskId: "agent-1",
        status: "running",
      },
    });

    expect(isSidebarV2ArchiveBlockedThread(parent)).toBe(false);
    expect(isSidebarV2ArchiveBlockedThread(runningGrandchild)).toBe(true);
    expect(isSidebarV2ArchiveBlockedThread(runningAgent)).toBe(true);

    const shelves = classifySidebarV2Shelves({
      threads: [parent, idleChild, runningGrandchild, runningAgent],
      now,
      expandedOverrideByThreadKey: new Map([
        [`${capableEnvironmentId}:${parent.id}`, true],
        [`${capableEnvironmentId}:${idleChild.id}`, true],
      ]),
    });
    const blockedByTitle = new Map(
      (shelves.active[0]?.rows ?? []).map((row) => [row.thread.title, row.archiveBlocked]),
    );
    expect(blockedByTitle).toEqual(
      new Map([
        ["Parent", true],
        ["Idle child", true],
        ["Running grandchild", true],
        ["Agent", true],
      ]),
    );
  });

  it("honors a working root's snooze unless a descendant still needs attention", () => {
    const workingRoot = thread({
      id: ThreadId.make("working-root"),
      title: "Working root",
      snoozedUntil: "2026-01-02T00:00:00.000Z",
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: "2026-01-01T11:00:00.000Z",
        startedAt: "2026-01-01T11:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      } as SidebarThreadSummary["latestTurn"],
    });
    const quietChild = thread({
      id: ThreadId.make("quiet-child"),
      parentThreadId: workingRoot.id,
      title: "Quiet child",
    });

    const snoozedShelves = classifySidebarV2Shelves({
      threads: [workingRoot, quietChild],
      now,
    });
    expect(resolveSidebarV2Status(workingRoot)).toBe("working");
    expect(rootsOf(snoozedShelves.snoozed)).toEqual([workingRoot]);
    expect(snoozedShelves.active).toEqual([]);

    const blockedChild = {
      ...quietChild,
      hasPendingApprovals: true,
    };
    const promotedShelves = classifySidebarV2Shelves({
      threads: [workingRoot, blockedChild],
      now,
    });
    expect(rootsOf(promotedShelves.active)).toEqual([workingRoot]);
    expect(promotedShelves.snoozed).toEqual([]);
  });

  it("drops cyclic and self parent references back to roots", () => {
    const left = thread({ id: ThreadId.make("left"), title: "Left" });
    const right = thread({ id: ThreadId.make("right"), title: "Right" });
    const cyclicLeft = { ...left, parentThreadId: right.id };
    const cyclicRight = { ...right, parentThreadId: left.id };
    const selfParented = thread({ id: ThreadId.make("self"), title: "Self" });

    const shelves = classifySidebarV2Shelves({
      threads: [cyclicLeft, cyclicRight, { ...selfParented, parentThreadId: selfParented.id }],
      now,
    });

    // One edge of the cycle is dropped so every thread still resolves to
    // exactly one root: the survivors are a two-thread group and the
    // self-parented root, never an infinite chain or a dropped thread.
    expect(
      shelves.active.map((group) => [group.root.title, group.rows[0]?.childCount]).toSorted(),
    ).toEqual([
      ["Left", 1],
      ["Self", 0],
    ]);
  });
});

describe("resolveSidebarV2ThreadRouteTarget", () => {
  it("routes a virtual agent row to its parent and selects the agent run", () => {
    const parentThreadId = ThreadId.make("parent-thread");
    const target = resolveSidebarV2ThreadRouteTarget(
      thread({
        id: ThreadId.make("agent-run:parent-thread:agent-1"),
        virtualAgentRun: {
          parentThreadId,
          taskId: "agent-1",
          status: "completed",
        },
      }),
    );

    expect(target).toEqual({ threadId: parentThreadId, agentTaskId: "agent-1" });
  });

  it("routes a real thread without an agent selection", () => {
    const realThread = thread({ id: ThreadId.make("real-thread") });

    expect(resolveSidebarV2ThreadRouteTarget(realThread)).toEqual({
      threadId: realThread.id,
      agentTaskId: null,
    });
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
